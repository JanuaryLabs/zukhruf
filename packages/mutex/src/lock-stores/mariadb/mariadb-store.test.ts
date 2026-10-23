import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import mariadb, {
  type Pool,
  type PoolConfig,
  type PoolConnection,
} from 'mariadb';

import { Mariadb, type MariadbDatabase } from '@zukhruf/testing/mariadb';

import { LeaseLostError, Mutex } from '../../index.ts';
import { MariadbStore } from './index.ts';

/**
 * The first tests are design errors that the probes of MariadbStore found. The
 * name of each test says what the wrong design broke. The last tests are the
 * contract of a lock store.
 */

const sequence = 'mutex_tokens';
const heartbeatInterval = 200;

const connectionOf = (database: MariadbDatabase) => ({
  host: database.host,
  port: database.port,
  user: database.user,
  password: database.password,
  database: database.database,
});

/** A new database with the token sequence that the app creates before it starts. */
async function mariadbDatabase() {
  const database = await new Mariadb({ environment: process.env }).database();
  const owner = await mariadb.createConnection(connectionOf(database));
  try {
    await owner.query(`CREATE SEQUENCE ${sequence}`);
  } finally {
    await owner.end();
  }
  return database;
}

/** Lock names belong to the whole server, and other tests share it. */
const uniqueKey = () => `report:${randomUUID()}`;

const poolOf = (database: MariadbDatabase, options: PoolConfig = {}) =>
  mariadb.createPool({ ...connectionOf(database), ...options });

const storeOver = (pool: Pool) =>
  new MariadbStore({
    connect: () => pool.getConnection(),
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

/** Resolves when a session of the database waits for a user lock. */
async function untilASessionWaitsForALock(database: MariadbDatabase) {
  const observer = await mariadb.createConnection(connectionOf(database));
  try {
    for (;;) {
      const rows = await observer.query<{ waiting: bigint }[]>(
        `SELECT COUNT(*) AS waiting FROM information_schema.PROCESSLIST
         WHERE DB = DATABASE() AND STATE = 'User lock'`,
      );
      if (Number(rows[0]?.['waiting']) > 0) return;
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
async function proxyTo(database: MariadbDatabase) {
  const partitioned = new AbortController();
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(database.port, database.host);
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
  return {
    port: address.port,
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
    await using database = await mariadbDatabase();
    await using cleanup = new AsyncDisposableStack();
    const proxy = await proxyTo(database);
    const pool = poolOf(database, { host: '127.0.0.1', port: proxy.port });
    cleanup.defer(() => pool.end());
    // Closed first: the closed sockets end the sessions, so the pool can end.
    cleanup.use(proxy);
    const mutex = new Mutex(storeOver(pool));

    // Act: the network stops silently while the task runs.
    const seen = Promise.withResolvers<{
      lost: 'lost' | 'still held';
      after: number;
    }>();
    const run = mutex.acquire(uniqueKey(), async (lease) => {
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

test(
  'a killed session loses its lease before the next heartbeat',
  { timeout: 30_000 },
  async () => {
    // Arrange: a heartbeat far away, so only the events of the session can tell the holder.
    await using database = await mariadbDatabase();
    const pool = poolOf(database);
    const sessions: PoolConnection[] = [];
    const store = new MariadbStore({
      connect: async () => {
        const session = await pool.getConnection();
        sessions.push(session);
        return session;
      },
      sequence,
      heartbeatInterval: 10_000,
    });
    const admin = await mariadb.createConnection(connectionOf(database));
    try {
      // Act
      const seen = Promise.withResolvers<'lost' | 'still held'>();
      const run = new Mutex(store).acquire(uniqueKey(), async (lease) => {
        const [holder] = sessions;
        assert.ok(holder);
        const lost = once(lease.signal, 'abort').then(() => 'lost' as const);
        await admin.query(`KILL ${holder.threadId}`);
        seen.resolve(
          await Promise.race([lost, delay(1000, 'still held' as const)]),
        );
      });
      const outcome = run.then(
        () => 'resolved',
        (error: unknown) => error,
      );

      // Assert
      assert.equal(
        await seen.promise,
        'lost',
        'A session that the server ended must abort the lease at once',
      );
      assert.ok((await outcome) instanceof LeaseLostError);
    } finally {
      await admin.end();
      await pool.end();
    }
  },
);

test(
  'the next acquire after a cancel gets the only session of the pool at once',
  { timeout: 30_000 },
  async () => {
    // Arrange: another pool holds the key, and the waiter's only session waits for it.
    await using database = await mariadbDatabase();
    const holderPool = poolOf(database);
    const waiterPool = poolOf(database, { connectionLimit: 1 });
    const key = uniqueKey();
    try {
      const holder = await hold(new Mutex(storeOver(holderPool)), key);
      const waiter = new Mutex(storeOver(waiterPool));
      const cancel = new AbortController();
      const reason = new Error('cancelled');
      const waiting = waiter.acquire(key, async () => 'ran', {
        signal: cancel.signal,
      });
      const outcome = waiting.then(
        (value) => value,
        (error: unknown) => error,
      );
      await untilASessionWaitsForALock(database);
      cancel.abort(reason);
      await holder.release();

      // Act
      const next = await Promise.race([
        waiter.acquire(key, async () => 'ran' as const),
        delay(300, 'still waiting' as const),
      ]);

      // Assert
      assert.equal(
        await outcome,
        reason,
        'The cancelled call must reject with the reason of its signal',
      );
      assert.equal(
        next,
        'ran',
        'A cancel must give back its turn and its session at once',
      );
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
    await using database = await mariadbDatabase();
    const pools = [1, 2, 3].map(() => poolOf(database));
    const [holderPool, waiterPool, nextPool] = pools;
    assert.ok(holderPool && waiterPool && nextPool);
    const key = uniqueKey();
    try {
      const holder = await hold(new Mutex(storeOver(holderPool)), key);
      const cancel = new AbortController();
      const waiting = new Mutex(storeOver(waiterPool)).acquire(
        key,
        async () => 'ran',
        { signal: cancel.signal },
      );
      await untilASessionWaitsForALock(database);
      cancel.abort(new Error('cancelled'));
      await assert.rejects(waiting);

      // Act: the holder releases at once, so the server can grant the cancelled waiter's place first.
      await holder.release();
      const next = await Promise.race([
        new Mutex(storeOver(nextPool)).acquire(
          key,
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
  'a released key leaves no lock on the session that goes back to the pool',
  { timeout: 30_000 },
  async () => {
    // Arrange: a pool of one session, so the next borrower gets the session that held the key.
    await using database = await mariadbDatabase();
    const pool = poolOf(database, { connectionLimit: 1 });
    try {
      // Act
      await new Mutex(storeOver(pool)).acquire(uniqueKey(), async () => {});
      const borrower = await pool.getConnection();
      try {
        const rows = await borrower.query<{ locks: number }[]>(
          'SELECT RELEASE_ALL_LOCKS() AS locks',
        );

        // Assert
        assert.equal(
          Number(rows[0]?.['locks']),
          0,
          'The next borrower of the session must not hold the released key',
        );
      } finally {
        await borrower.release();
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  'a wait outlasts the max_statement_time of its session',
  { timeout: 30_000 },
  async () => {
    // Arrange: the app's sessions stop each SELECT after 300 ms.
    await using database = await mariadbDatabase();
    const holderPool = poolOf(database);
    const waiterPool = poolOf(database);
    const key = uniqueKey();
    try {
      const holder = await hold(new Mutex(storeOver(holderPool)), key);
      const waiter = new MariadbStore({
        connect: async () => {
          const session = await waiterPool.getConnection();
          await session.query('SET SESSION max_statement_time = 0.3');
          return session;
        },
        sequence,
        heartbeatInterval,
      });
      const waiting = new Mutex(waiter).acquire(key, async () => 'ran');

      // Act: the holder keeps the key longer than the time limit.
      await delay(1000);
      await holder.release();

      // Assert
      assert.equal(
        await waiting,
        'ran',
        'The wait for the key must not end at the time limit of a statement',
      );
    } finally {
      await holderPool.end();
      await waiterPool.end();
    }
  },
);

test(
  'a key longer than 192 characters is a lock',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using database = await mariadbDatabase();
    const pool = poolOf(database);
    const key = `${'report:'.repeat(40)}${randomUUID()}`;
    try {
      const store = storeOver(pool);
      const holder = await hold(new Mutex(store), key);
      try {
        // Act
        const held = await storeOver(pool).isHeld(key);

        // Assert
        assert.equal(held, true, 'A long key must be held like a short key');
      } finally {
        await holder.release();
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  'a user with only SELECT and INSERT on the sequence can acquire',
  { timeout: 30_000 },
  async () => {
    // Arrange: root made the sequence; the app's user may read and advance it, and create nothing.
    await using database = await mariadbDatabase();
    const user = `mutex_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const owner = await mariadb.createConnection(connectionOf(database));
    try {
      await owner.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'app'`);
      await owner.query(
        `GRANT SELECT, INSERT ON \`${database.database}\`.${sequence} TO '${user}'@'%'`,
      );
      const pool = poolOf(database, { user, password: 'app' });
      try {
        // Act
        const token = await new Mutex(storeOver(pool)).acquire(
          uniqueKey(),
          async (lease) => lease.token,
        );

        // Assert
        assert.equal(token.value, 1n);
      } finally {
        await pool.end();
      }
    } finally {
      // A user belongs to the server, not to the database of the test.
      await owner.query(`DROP USER '${user}'@'%'`);
      await owner.end();
    }
  },
);

test(
  'two stores in different databases on one server do not share a key',
  { timeout: 30_000 },
  async () => {
    // Arrange: two databases on one server, each with its own token source.
    await using first = await mariadbDatabase();
    await using second = await mariadbDatabase();
    const pools = [poolOf(first), poolOf(second)];
    const [firstPool, secondPool] = pools;
    assert.ok(firstPool && secondPool);
    const key = uniqueKey();
    try {
      const holder = await hold(new Mutex(storeOver(firstPool)), key);
      try {
        // Act
        const other = await storeOver(secondPool).tryAcquire(key);

        // Assert: one lock with two token sources could give a later holder a smaller token.
        assert.ok(other, 'A key in another database must be free');
        await other[Symbol.asyncDispose]();
      } finally {
        await holder.release();
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);

test(
  'two stores on one database never run two holders of a key at once',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using database = await mariadbDatabase();
    const pools = [poolOf(database), poolOf(database)];
    const mutexes = pools.map((pool) => new Mutex(storeOver(pool)));
    const key = uniqueKey();
    let running = 0;
    let most = 0;
    try {
      // Act
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          mutexes[index % 2]?.acquire(key, async () => {
            running++;
            most = Math.max(most, running);
            await delay(20);
            running--;
          }),
        ),
      );

      // Assert
      assert.equal(most, 1, 'Only one holder may run at a time');
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);

test(
  'a waiter gets the key when the holder releases it',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using database = await mariadbDatabase();
    const pools = [poolOf(database), poolOf(database)];
    const [holderPool, waiterPool] = pools;
    assert.ok(holderPool && waiterPool);
    const key = uniqueKey();
    try {
      const holder = await hold(new Mutex(storeOver(holderPool)), key);
      const waiting = new Mutex(storeOver(waiterPool)).acquire(
        key,
        async () => 'ran' as const,
      );
      await untilASessionWaitsForALock(database);
      const early = await Promise.race([waiting, delay(100, 'waiting')]);

      // Act
      await holder.release();

      // Assert
      assert.equal(
        early,
        'waiting',
        'The waiter must wait while the key is held',
      );
      assert.equal(await waiting, 'ran');
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);

test(
  'tryAcquire gives up on a key that another store holds',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using database = await mariadbDatabase();
    const pools = [poolOf(database), poolOf(database)];
    const [holderPool, otherPool] = pools;
    assert.ok(holderPool && otherPool);
    const key = uniqueKey();
    try {
      const holder = await hold(new Mutex(storeOver(holderPool)), key);
      try {
        // Act
        const handle = await storeOver(otherPool).tryAcquire(key);

        // Assert
        assert.equal(handle, undefined);
      } finally {
        await holder.release();
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);

test(
  'isHeld tells a held key from a free key, and never acquires it',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using database = await mariadbDatabase();
    const pools = [poolOf(database), poolOf(database)];
    const [holderPool, checkerPool] = pools;
    assert.ok(holderPool && checkerPool);
    const holderStore = storeOver(holderPool);
    const checker = storeOver(checkerPool);
    const key = uniqueKey();
    try {
      // Act
      const freeBefore = await checker.isHeld(key);
      const holder = await hold(new Mutex(holderStore), key);
      const whileHeld = await checker.isHeld(key);
      await holder.release();
      const afterRelease = await checker.isHeld(key);
      const handle = await holderStore.tryAcquire(key);

      // Assert
      assert.deepEqual(
        [freeBefore, whileHeld, afterRelease],
        [false, true, false],
      );
      assert.ok(handle, 'A holder check must leave the key free');
      await handle[Symbol.asyncDispose]();
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);

test(
  'tokens increase across grants of two stores',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using database = await mariadbDatabase();
    const pools = [poolOf(database), poolOf(database)];
    const mutexes = pools.map((pool) => new Mutex(storeOver(pool)));
    const key = uniqueKey();
    const tokens: bigint[] = [];
    try {
      // Act
      for (let grant = 0; grant < 4; grant++) {
        const mutex = mutexes[grant % 2];
        assert.ok(mutex);
        tokens.push(
          await mutex.acquire(key, async (lease) => lease.token.value),
        );
      }

      // Assert
      assert.deepEqual(
        tokens,
        [...tokens].sort((a, b) => (a < b ? -1 : 1)),
      );
      assert.equal(new Set(tokens).size, tokens.length);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);
