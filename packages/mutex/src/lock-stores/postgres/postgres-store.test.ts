import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { Postgres } from '@zukhruf/testing/postgres';

import { LeaseLostError, Modes, Mutex } from '../../index.ts';
import {
  type StoreCase,
  deadlineFor,
  postgresPool,
  storeCases,
} from '../../testing/store-cases.ts';
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

const storeOver = (pool: Pick<pg.Pool, 'connect'>) =>
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
async function untilASessionWaitsForALock(
  t: TestContext,
  connectionString: string,
) {
  const observer = new pg.Client({ connectionString });
  await observer.connect();
  try {
    await t.waitFor(
      async () => {
        const { rows } = await observer.query(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        assert.ok(rows[0].waiting > 0, 'No session waits for a lock.');
      },
      { interval: 10, timeout: 10_000 },
    );
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
    const { pool } = cleanup.use(
      postgresPool({ connectionString: proxy.connectionString }),
    );
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
 * listeners hear nothing. A query that fails on the ended connection runs
 * again on the new one. `reconnected` resolves once the new connection is up.
 * Queries on the new connection wait until `resume()`, so the test
 * decides when the store sees it.
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
  const resumed = Promise.withResolvers<void>();
  let reconnectedYet = false;
  current.once('end', () => {
    open().then((next) => {
      current = next;
      reconnectedYet = true;
      reconnected.resolve();
    }, reconnected.reject);
  });
  const session: PostgresSession = {
    query: async (text, values) => {
      try {
        if (!reconnectedYet) return await current.query(text, values);
      } catch {
        await reconnected.promise;
      }
      await resumed.promise;
      return current.query(text, values);
    },
    on: () => session,
    off: () => session,
    release: () => void current.end(),
  };
  return {
    session,
    pid: rows[0].pid,
    reconnected: reconnected.promise,
    resume: () => resumed.resolve(),
  };
}

test(
  'a session that reconnects silently loses its lease',
  { timeout: 30_000 },
  async () => {
    // Arrange: the holder's session hides the end of its connection and connects again.
    // The store sees the new connection only after the other store took the key, and
    // a heartbeat interval longer than a reconnect and a take keeps its beat in time.
    const interval = 1000;
    const postgres = storeCases.find(
      (candidate) => candidate.name === 'PostgresStore',
    );
    assert.ok(postgres);
    const deadline = deadlineFor(postgres, 2 * interval, {
      grants: 1,
      releases: 1,
    });
    await using database = await postgresDatabase();
    const reconnecting = await silentlyReconnectingSession(
      database.connectionString,
    );
    const store = new PostgresStore({
      connect: async () => reconnecting.session,
      sequence,
      heartbeatInterval: interval,
    });
    const admin = new pg.Client({
      connectionString: database.connectionString,
    });
    await admin.connect();
    await using otherPool = postgresPool({
      connectionString: database.connectionString,
    });
    const handle = await store.acquire('report:daily');
    await using other = new AsyncDisposableStack();
    try {
      // Act: the server ends the holder's connection, which frees the key, and another store takes the key.
      // Listen first, so the deadline counts from the end of the connection.
      const lost = Promise.race([
        once(handle.signal, 'abort').then(() => 'lost' as const),
        delay(deadline, 'still held' as const),
      ]);
      await admin.query('SELECT pg_terminate_backend($1)', [reconnecting.pid]);
      await reconnecting.reconnected;
      const heldAfterReconnect = !handle.signal.aborted;
      const taken = await storeOver(otherPool.pool).tryAcquire('report:daily');
      if (taken) other.use(taken);
      reconnecting.resume();

      // Assert: the heartbeat asks whether this session holds the lock, not whether any session does.
      assert.ok(
        heldAfterReconnect,
        'The reconnect itself must not lose the lease',
      );
      assert.ok(taken, 'The ended connection must have freed the key');
      assert.equal(
        await lost,
        'lost',
        `A session that answers but no longer holds the lock must lose the lease within ${deadline} ms of the end of its connection`,
      );
      const reason: unknown = handle.signal.reason;
      assert.ok(reason instanceof LeaseLostError);
      assert.match(String(reason.cause), /no longer holds the lock/);
    } finally {
      reconnecting.resume();
      await other.disposeAsync();
      await handle[Symbol.asyncDispose]();
      await admin.end();
    }
  },
);

test(
  'the next acquire after a cancel gets the only session of the pool at once',
  { timeout: 30_000 },
  async (t) => {
    // Arrange: another pool holds the key, and the waiter's only session waits for it.
    await using database = await postgresDatabase();
    await using holderPool = postgresPool({
      connectionString: database.connectionString,
    });
    await using waiterPool = postgresPool({
      connectionString: database.connectionString,
      max: 1,
    });
    const holder = await hold(
      new Mutex(storeOver(holderPool.pool)),
      'report:daily',
    );
    const waiter = new Mutex(storeOver(waiterPool.pool));
    const cancel = new AbortController();
    const reason = new Error('cancelled');
    const waiting = waiter.acquire('report:daily', async () => 'ran', {
      signal: cancel.signal,
    });
    const outcome = waiting.then(
      (value) => value,
      (error: unknown) => error,
    );
    await untilASessionWaitsForALock(t, database.connectionString);
    cancel.abort(reason);
    await holder.release();

    // Act
    const next = await Promise.race([
      waiter.acquire('report:daily', async () => 'ran' as const),
      delay(300, 'still waiting' as const),
    ]);

    // Assert: first the next acquire, because a cancel that waits for a second session never settles.
    assert.equal(
      next,
      'ran',
      'A cancel must give back its turn and its session at once',
    );
    assert.equal(
      await outcome,
      reason,
      'The cancelled call must reject with the reason of its signal',
    );
  },
);

test(
  'a cancelled waiter that the server grants later gives the key to the next waiter',
  { timeout: 30_000 },
  async (t) => {
    // Arrange: a holder, and a waiter in another pool that cancels while the server keeps its place in the queue.
    await using database = await postgresDatabase();
    await using holderPool = postgresPool({
      connectionString: database.connectionString,
    });
    await using waiterPool = postgresPool({
      connectionString: database.connectionString,
    });
    await using nextPool = postgresPool({
      connectionString: database.connectionString,
    });
    const holder = await hold(
      new Mutex(storeOver(holderPool.pool)),
      'report:daily',
    );
    const cancel = new AbortController();
    const waiting = new Mutex(storeOver(waiterPool.pool)).acquire(
      'report:daily',
      async () => 'ran',
      { signal: cancel.signal },
    );
    await untilASessionWaitsForALock(t, database.connectionString);
    cancel.abort(new Error('cancelled'));
    await assert.rejects(waiting);

    // Act: the holder releases, so the server can grant the cancelled waiter's place first.
    await holder.release();
    const next = await Promise.race([
      new Mutex(storeOver(nextPool.pool)).acquire(
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
      await using app = postgresPool({
        connectionString: asApp.toString(),
      });

      // Act
      const token = await new Mutex(storeOver(app.pool)).acquire(
        'report:daily',
        async (lease) => lease.token,
      );

      // Assert
      assert.equal(token.value, 1n);
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
    await using oneSession = postgresPool({
      connectionString: database.connectionString,
      max: 1,
    });

    // Act
    await new Mutex(storeOver(oneSession.pool)).acquire(
      'report:daily',
      async () => {},
    );
    const borrower = await oneSession.pool.connect();
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
  },
);

/**
 * One test of the shared store suites over the PostgresStore case: four
 * holders and a skipped try give the host's pool five sessions, then the host
 * is disposed. Returns how many sessions the server still has on the
 * fixture's database at that moment, before the fixture drops it.
 */
async function sessionsAfterTheHostIsDisposed(
  postgresCase: StoreCase,
): Promise<number> {
  await using fixture = await postgresCase.fixture(process.env);
  // Connected before the host opens, so the count is read right after the disposal.
  const server = new URL(fixture.location);
  const database = decodeURIComponent(server.pathname.slice(1));
  server.pathname = '/postgres';
  const observer = new pg.Client({ connectionString: server.toString() });
  await observer.connect();
  try {
    {
      await using host = postgresCase.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holders = await Promise.all(
        [1, 2, 3, 4].map((day) => hold(mutex, `report:${day}`)),
      );
      const skipped = await mutex.acquire('report:1', async () => 'ran', {
        mode: Modes.skipIfBusy(),
      });
      await Promise.all(holders.map((holder) => holder.release()));
      assert.deepEqual(
        skipped,
        { acquired: false },
        'The try must find the key busy',
      );
    }
    const { rows } = await observer.query(
      'SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1',
      [database],
    );
    return rows[0].sessions;
  } finally {
    await observer.end();
  }
}

test(
  "a disposed PostgresStore case host leaves no session of its pool on the server, so the fixture's drop cannot end a connection the pool still owns",
  { timeout: 120_000 },
  async () => {
    // Arrange: the case of the shared store suites. A session left behind is a race, so the cycle runs many times.
    const postgresCase = storeCases.find(
      (candidate) => candidate.name === 'PostgresStore',
    );
    assert.ok(postgresCase);
    const cycles = 60;
    for (let cycle = 1; cycle <= cycles; cycle++) {
      // Act
      const sessions = await sessionsAfterTheHostIsDisposed(postgresCase);

      // Assert
      assert.equal(
        sessions,
        0,
        `Cycle ${cycle} of ${cycles}: ${sessions} session(s) of the disposed host's pool were still on the server`,
      );
    }
  },
);

test(
  "postgresPool's disposal resolves only after every client of its pool has ended, including one that was checked out when the disposal began",
  { timeout: 30_000 },
  async () => {
    // Arrange: five clients of the pool; two go back idle, and three stay checked out.
    await using database = await postgresDatabase();
    const helper = postgresPool({
      connectionString: database.connectionString,
    });
    const idle = [await helper.pool.connect(), await helper.pool.connect()];
    const held = [
      await helper.pool.connect(),
      await helper.pool.connect(),
      await helper.pool.connect(),
    ];
    const order: string[] = [];
    for (const [index, client] of [...idle, ...held].entries()) {
      client.once('end', () => order.push(`client ${index + 1}`));
    }
    for (const client of idle) client.release();

    // Act
    const disposal = helper[Symbol.asyncDispose]().then(() =>
      order.push('disposal'),
    );
    try {
      await Promise.all(idle.map((client) => once(client, 'end')));

      // Assert
      assert.ok(
        !order.includes('disposal'),
        'The disposal must not resolve while clients of the pool are checked out',
      );
    } finally {
      // All at once: pool.end() then resolves at the first 'remove', while two sockets are still open.
      for (const client of held) client.release();
      await disposal;
    }
    assert.equal(
      order.indexOf('disposal'),
      idle.length + held.length,
      `Every client of the pool must have ended when the disposal resolves; the order was ${order.join(', ')}`,
    );
  },
);

test(
  'a pool of postgresPool has no end, so its disposal is the only way to end it',
  { timeout: 30_000 },
  () => {
    // A function that is never called: the type checker reads it.
    const end = (helper: ReturnType<typeof postgresPool>) =>
      // @ts-expect-error a helper pool has no end; its disposal is the only end (#3305).
      helper.pool.end();
    assert.equal(typeof end, 'function');
  },
);
