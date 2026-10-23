import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { Postgres } from '@zukhruf/testing/postgres';

import { LeaseLostError, Mutex } from '../../index.ts';
import { type PostgresSession, PostgresStore } from './index.ts';

/**
 * Each test is a design error that the review of PostgresStore found. The
 * name of the test says what the wrong design broke.
 */

const sequence = 'mutex_tokens';
const heartbeatInterval = 200;

/** A new database with the token sequence that the app creates before it starts. */
async function postgresDatabase() {
  const database = await new Postgres({ environment: process.env }).database();
  const owner = new pg.Client({ connectionString: database.connectionString });
  await owner.connect();
  try {
    await owner.query(`CREATE SEQUENCE ${sequence} AS bigint CACHE 1`);
  } finally {
    await owner.end();
  }
  return database;
}

const storeOver = (pool: pg.Pool) =>
  new PostgresStore({
    connect: () => pool.connect(),
    sequence,
    heartbeatInterval,
  });

/** Holds `key` until the returned `release` is called. */
async function hold(mutex: Mutex, key: string) {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const held = mutex.acquire(key, async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  return {
    release: async () => {
      finish.resolve();
      await held;
    },
  };
}

/** Resolves when a session of the database waits for a lock. */
async function untilASessionWaitsForALock(connectionString: string) {
  const observer = new pg.Client({ connectionString });
  await observer.connect();
  try {
    for (;;) {
      const { rows } = await observer.query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0].waiting > 0) return;
      await delay(10);
    }
  } finally {
    await observer.end();
  }
}

/**
 * A TCP proxy in front of the server. `partition()` stops forwarding in both
 * directions and closes no socket: the network stopped without a reset.
 */
async function proxyTo(connectionString: string) {
  const target = new URL(connectionString);
  const partitioned = new AbortController();
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      sockets.add(from);
      from.on('error', () => {});
      from.on('close', () => to.destroy());
      from.on('data', (chunk) => {
        if (!partitioned.signal.aborted) to.write(chunk);
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const proxied = new URL(connectionString);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(address.port);
  return {
    connectionString: proxied.toString(),
    partition: () => partitioned.abort(),
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test(
  'a held key is lost within heartbeatInterval when the server stops answering',
  { timeout: 30_000 },
  async () => {
    // Arrange: the store reaches the server through a proxy, and holds a key.
    await using database = await postgresDatabase();
    await using cleanup = new AsyncDisposableStack();
    const proxy = await proxyTo(database.connectionString);
    const pool = new pg.Pool({ connectionString: proxy.connectionString });
    cleanup.defer(() => pool.end());
    // Closed first: the closed sockets end a release that waits for an answer, so the pool can end.
    cleanup.use(proxy);
    const mutex = new Mutex(storeOver(pool));

    // Act: the network stops silently while the task runs.
    const seen = Promise.withResolvers<{
      lost: 'lost' | 'still held';
      after: number;
    }>();
    const run = mutex.acquire('report:daily', async (lease) => {
      proxy.partition();
      const started = performance.now();
      const lost = await Promise.race([
        once(lease.signal, 'abort').then(() => 'lost' as const),
        delay(2000, 'still held' as const),
      ]);
      seen.resolve({ lost, after: performance.now() - started });
    });
    const { lost, after } = await seen.promise;

    // Assert: one interval to the next heartbeat, one interval for its answer.
    assert.equal(
      lost,
      'lost',
      'The holder must learn that its session may be gone',
    );
    assert.ok(
      after < 2 * heartbeatInterval + 150,
      `The lease was lost ${after.toFixed(0)} ms after the partition, later than two heartbeat intervals`,
    );
    await assert.rejects(run, LeaseLostError);
  },
);

/**
 * A session that connects again by itself when the server ends its
 * connection, and tells the store nothing: no `error`, no `end`. The store's
 * listeners hear nothing. `reconnected` resolves once the new connection is up.
 */
async function silentlyReconnectingSession(connectionString: string) {
  const open = async () => {
    const client = new pg.Client({ connectionString });
    client.on('error', () => {});
    await client.connect();
    return client;
  };
  let current = await open();
  const { rows } = await current.query('SELECT pg_backend_pid() AS pid');
  const reconnected = Promise.withResolvers<void>();
  current.once('end', () => {
    open().then((next) => {
      current = next;
      reconnected.resolve();
    }, reconnected.reject);
  });
  const session: PostgresSession = {
    query: (text, values) => current.query(text, values),
    on: () => session,
    off: () => session,
    release: () => void current.end(),
  };
  return { session, pid: rows[0].pid, reconnected: reconnected.promise };
}

test(
  'a session that reconnects silently loses its lease',
  { timeout: 30_000 },
  async () => {
    // Arrange: the holder's session hides the end of its connection and connects again.
    await using database = await postgresDatabase();
    const reconnecting = await silentlyReconnectingSession(
      database.connectionString,
    );
    const store = new PostgresStore({
      connect: async () => reconnecting.session,
      sequence,
      heartbeatInterval,
    });
    const admin = new pg.Client({
      connectionString: database.connectionString,
    });
    await admin.connect();
    const handle = await store.acquire('report:daily');
    try {
      // Act: the server ends the holder's connection, which frees the key.
      await admin.query('SELECT pg_terminate_backend($1)', [reconnecting.pid]);
      await reconnecting.reconnected;
      const lost = await Promise.race([
        once(handle.signal, 'abort').then(() => 'lost' as const),
        delay(2 * heartbeatInterval + 500, 'still held' as const),
      ]);

      // Assert
      assert.equal(
        lost,
        'lost',
        'A session that answers but no longer holds the lock must lose the lease',
      );
      assert.ok(handle.signal.reason instanceof LeaseLostError);
    } finally {
      await handle[Symbol.asyncDispose]();
      await admin.end();
    }
  },
);

test(
  'a cancel ends a wait when every session of the pool is busy',
  { timeout: 30_000 },
  async () => {
    // Arrange: another pool holds the key, and the waiter's only session waits for it.
    await using database = await postgresDatabase();
    const holderPool = new pg.Pool({
      connectionString: database.connectionString,
    });
    const waiterPool = new pg.Pool({
      connectionString: database.connectionString,
      max: 1,
    });
    try {
      const holder = await hold(
        new Mutex(storeOver(holderPool)),
        'report:daily',
      );
      try {
        const cancel = new AbortController();
        const reason = new Error('cancelled');
        const waiting = new Mutex(storeOver(waiterPool)).acquire(
          'report:daily',
          async () => 'ran',
          { signal: cancel.signal },
        );
        await untilASessionWaitsForALock(database.connectionString);

        // Act
        cancel.abort(reason);
        const outcome = await Promise.race([
          waiting.then(
            (value) => value,
            (error: unknown) => error,
          ),
          delay(1000, 'still waiting' as const),
        ]);

        // Assert
        assert.equal(
          outcome,
          reason,
          'The cancelled call must reject with the reason of its signal at once',
        );
      } finally {
        await holder.release();
      }
    } finally {
      await holderPool.end();
      await waiterPool.end();
    }
  },
);

test(
  'a cancelled waiter that the server grants later gives the key to the next waiter',
  { timeout: 30_000 },
  async () => {
    // Arrange: a holder, and a waiter in another pool that cancels while the server keeps its place in the queue.
    await using database = await postgresDatabase();
    const pools = [1, 2, 3].map(
      () => new pg.Pool({ connectionString: database.connectionString }),
    );
    const [holderPool, waiterPool, nextPool] = pools;
    assert.ok(holderPool && waiterPool && nextPool);
    try {
      const holder = await hold(
        new Mutex(storeOver(holderPool)),
        'report:daily',
      );
      const cancel = new AbortController();
      const waiting = new Mutex(storeOver(waiterPool)).acquire(
        'report:daily',
        async () => 'ran',
        { signal: cancel.signal },
      );
      await untilASessionWaitsForALock(database.connectionString);
      cancel.abort(new Error('cancelled'));
      await assert.rejects(waiting);

      // Act: the holder releases, so the server can grant the cancelled waiter's place first.
      await holder.release();
      const next = await Promise.race([
        new Mutex(storeOver(nextPool)).acquire(
          'report:daily',
          async () => 'granted' as const,
        ),
        delay(2000, 'still waiting' as const),
      ]);

      // Assert
      assert.equal(
        next,
        'granted',
        'A grant to a cancelled waiter must be released, so the next waiter gets the key',
      );
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);

test(
  'a role with only USAGE on the sequence can acquire',
  { timeout: 30_000 },
  async () => {
    // Arrange: the owner made the sequence; the role of the app may use it, and create nothing.
    await using database = await postgresDatabase();
    const role = `mutex_app_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Client({
      connectionString: database.connectionString,
    });
    await owner.connect();
    try {
      await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app'`);
      await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await owner.query(`GRANT USAGE ON SEQUENCE ${sequence} TO ${role}`);
      const asApp = new URL(database.connectionString);
      asApp.username = role;
      asApp.password = 'app';
      const pool = new pg.Pool({ connectionString: asApp.toString() });
      try {
        // Act
        const token = await new Mutex(storeOver(pool)).acquire(
          'report:daily',
          async (lease) => lease.token,
        );

        // Assert
        assert.equal(token.value, 1n);
      } finally {
        await pool.end();
      }
    } finally {
      // A role belongs to the server, not to the database of the test.
      await owner.query(`DROP OWNED BY ${role}`);
      await owner.query(`DROP ROLE ${role}`);
      await owner.end();
    }
  },
);

test(
  'a released key leaves no lock on the session that goes back to the pool',
  { timeout: 30_000 },
  async () => {
    // Arrange: a pool of one session, so the next borrower gets the session that held the key.
    await using database = await postgresDatabase();
    const pool = new pg.Pool({
      connectionString: database.connectionString,
      max: 1,
    });
    try {
      // Act
      await new Mutex(storeOver(pool)).acquire('report:daily', async () => {});
      const borrower = await pool.connect();
      try {
        const { rows } = await borrower.query(
          `SELECT count(*)::int AS locks FROM pg_locks
           WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
        );

        // Assert
        assert.equal(
          rows[0].locks,
          0,
          'The next borrower of the session must not hold the released key',
        );
      } finally {
        borrower.release();
      }
    } finally {
      await pool.end();
    }
  },
);
