import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Connection, Request, TYPES } from 'tedious';

import { type Database, SqlServer } from '@zukhruf/testing/sqlserver';

import { LeaseLostError } from '../../index.ts';
import { type SqlServerSession, SqlServerStore } from './index.ts';

/**
 * The first tests are the contract of a lock store. Each test after them is a
 * design error that a probe of SQL Server found. The name of the test says
 * what the wrong design broke.
 */

const sequence = 'dbo.mutex_tokens';
const heartbeatInterval = 200;

/** A column of a row that tedious gives with `useColumnNames` off, its default. */
interface Column {
  metadata: { colName: string };
  value: unknown;
}

interface Endpoint {
  host: string;
  port: number;
}

/** A new database with the token sequence that the app creates before it starts. */
async function sqlServerDatabase() {
  const database = await new SqlServer({
    environment: process.env,
  }).database();
  const owner = await sessionTo(database, database);
  try {
    await owner.query(
      `CREATE SEQUENCE ${sequence} AS bigint START WITH 1 NO CACHE`,
      {},
    );
  } finally {
    owner.close();
  }
  return database;
}

/** The caller's wrapper that the SqlServerStore page shows: one tedious connection is one session. */
async function sessionTo(
  database: Database,
  endpoint: Endpoint,
): Promise<SqlServerSession> {
  const connection = new Connection({
    server: endpoint.host,
    authentication: {
      type: 'default',
      options: { userName: database.user, password: database.password },
    },
    options: {
      port: endpoint.port,
      database: database.database,
      encrypt: false,
      trustServerCertificate: true,
      requestTimeout: 0,
    },
  });
  await new Promise<void>((resolve, reject) =>
    connection.connect((error) => (error ? reject(error) : resolve())),
  );
  // A connection already has `on` and `close`, so the session only adds `query`.
  return Object.assign(connection, {
    query: (text: string, parameters: Record<string, string>) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const rows: Record<string, unknown>[] = [];
        const request = new Request(text, (error) =>
          error ? reject(error) : resolve(rows),
        );
        for (const [name, value] of Object.entries(parameters)) {
          request.addParameter(name, TYPES.NVarChar, value);
        }
        request.on('row', (columns: Column[]) =>
          rows.push(
            Object.fromEntries(
              columns.map((column) => [column.metadata.colName, column.value]),
            ),
          ),
        );
        connection.execSql(request);
      }),
  });
}

const storeOver = (database: Database, endpoint: Endpoint = database) =>
  new SqlServerStore({
    connect: () => sessionTo(database, endpoint),
    sequence,
    heartbeatInterval,
  });

/** Runs `text` on a session of the test, not of a store. */
async function observe(database: Database, text: string) {
  const session = await sessionTo(database, database);
  try {
    return await session.query(text, {});
  } finally {
    session.close();
  }
}

/** Resolves when a session of the database waits for an application lock. */
async function untilASessionWaitsForALock(database: Database) {
  for (;;) {
    const rows = await observe(
      database,
      `SELECT count(*) AS waiting FROM sys.dm_tran_locks
       WHERE resource_type = N'APPLICATION' AND resource_database_id = DB_ID() AND request_status = N'WAIT'`,
    );
    if (Number(rows[0]?.waiting) > 0) return;
    await delay(10);
  }
}

/**
 * A TCP proxy in front of the server. `partition()` stops forwarding in both
 * directions and closes no socket: the network stopped without a reset.
 */
async function proxyTo(target: Endpoint) {
  const partitioned = new AbortController();
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(target.port, target.host);
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
    host: '127.0.0.1',
    port: address.port,
    partition: () => partitioned.abort(),
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test(
  'two stores on one database never hold a key at the same time',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using database = await sqlServerDatabase();
    const stores = [storeOver(database), storeOver(database)];
    let holders = 0;
    let most = 0;

    // Act: ten callers in each store want one key.
    await Promise.all(
      stores.flatMap((store) =>
        Array.from({ length: 10 }, async () => {
          await using _ = await store.acquire('report:daily');
          holders++;
          most = Math.max(most, holders);
          await delay(5);
          holders--;
        }),
      ),
    );

    // Assert
    assert.equal(most, 1);
  },
);

test(
  'a waiter in another store gets the key after the holder releases',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using database = await sqlServerDatabase();
    const holder = await storeOver(database).acquire('report:daily');
    const waiting = storeOver(database).acquire('report:daily');
    await untilASessionWaitsForALock(database);

    // Act
    await holder[Symbol.asyncDispose]();
    const granted = await Promise.race([waiting, delay(5000, 'still waiting')]);

    // Assert
    assert.notEqual(granted, 'still waiting');
    if (typeof granted !== 'string') await granted[Symbol.asyncDispose]();
  },
);

test(
  'tryAcquire gives up on a key that another store holds',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using database = await sqlServerDatabase();
    await using _ = await storeOver(database).acquire('report:daily');

    // Act
    const attempt = await storeOver(database).tryAcquire('report:daily');

    // Assert
    assert.equal(attempt, undefined);
  },
);

test(
  'isHeld answers true for a holder in another store and false after the release, without taking the key',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using database = await sqlServerDatabase();
    const checker = storeOver(database);
    const holder = await storeOver(database).acquire('report:daily');

    // Act
    const whileHeld = await checker.isHeld('report:daily');
    await holder[Symbol.asyncDispose]();
    const afterRelease = await checker.isHeld('report:daily');
    const attempt = await storeOver(database).tryAcquire('report:daily');

    // Assert
    assert.deepEqual([whileHeld, afterRelease], [true, false]);
    assert.ok(attempt, 'A holder check must leave the free key free');
    await attempt[Symbol.asyncDispose]();
  },
);

test(
  'the tokens of later grants are larger, across stores',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using database = await sqlServerDatabase();
    const stores = [storeOver(database), storeOver(database)];
    const tokens: bigint[] = [];

    // Act
    for (let index = 0; index < 4; index++) {
      const store = stores[index % 2];
      assert.ok(store);
      await using handle = await store.acquire('report:daily');
      tokens.push(handle.token.value);
    }

    // Assert
    assert.deepEqual(tokens, [1n, 2n, 3n, 4n]);
  },
);

test(
  'a cancelled acquire rejects with the reason of its signal',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using database = await sqlServerDatabase();
    await using _ = await storeOver(database).acquire('report:daily');
    const cancel = new AbortController();
    const reason = new Error('cancelled');
    const waiting = storeOver(database).acquire('report:daily', {
      signal: cancel.signal,
    });
    await untilASessionWaitsForALock(database);

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
    assert.equal(outcome, reason);
  },
);

test(
  'a key is free for another store as soon as its release resolves',
  { timeout: 120_000 },
  async () => {
    // Arrange: the server sees a closed connection a little later than the
    // close. The other store gets sessions that are already open, as from a pool.
    await using database = await sqlServerDatabase();
    const holder = storeOver(database);
    let busy = 0;

    // Act
    for (let round = 0; round < 200; round++) {
      const open = await sessionTo(database, database);
      const other = new SqlServerStore({
        connect: async () => open,
        sequence,
        heartbeatInterval,
      });
      const handle = await holder.acquire(`report:${round}`);
      await handle[Symbol.asyncDispose]();
      const attempt = await other.tryAcquire(`report:${round}`);
      if (attempt) await attempt[Symbol.asyncDispose]();
      else busy++;
    }

    // Assert
    assert.equal(
      busy,
      0,
      'A release must free the key on the server before it resolves',
    );
  },
);

test(
  'a cancelled waiter that the server grants later gives the key to the next waiter',
  { timeout: 60_000 },
  async () => {
    // Arrange: a holder, and a waiter in another store that cancels.
    await using database = await sqlServerDatabase();
    const holder = await storeOver(database).acquire('report:daily');
    const cancel = new AbortController();
    const waiting = storeOver(database).acquire('report:daily', {
      signal: cancel.signal,
    });
    await untilASessionWaitsForALock(database);
    cancel.abort(new Error('cancelled'));
    await assert.rejects(waiting);

    // Act: the holder releases, so the server can grant the cancelled waiter's place first.
    await holder[Symbol.asyncDispose]();
    const next = await Promise.race([
      storeOver(database).acquire('report:daily'),
      delay(2000, 'still waiting' as const),
    ]);

    // Assert
    assert.notEqual(
      next,
      'still waiting',
      'A grant to a cancelled waiter must be released, so the next waiter gets the key',
    );
    if (typeof next !== 'string') await next[Symbol.asyncDispose]();
  },
);

test(
  'two keys that differ only after 255 characters are two locks',
  { timeout: 60_000 },
  async () => {
    // Arrange: sp_getapplock cuts a longer resource name to 255 characters.
    await using database = await sqlServerDatabase();
    const prefix = 'k'.repeat(255);
    await using _ = await storeOver(database).acquire(`${prefix}:a`);

    // Act
    const other = await storeOver(database).tryAcquire(`${prefix}:b`);

    // Assert
    assert.ok(other, 'A key must not wait for another key');
    await other[Symbol.asyncDispose]();
  },
);

test(
  'a held key is lost within heartbeatInterval when the server stops answering',
  { timeout: 60_000 },
  async () => {
    // Arrange: the store reaches the server through a proxy, and holds a key.
    await using database = await sqlServerDatabase();
    await using proxy = await proxyTo(database);
    const handle = await storeOver(database, proxy).acquire('report:daily');

    // Act: the network stops silently while the key is held.
    proxy.partition();
    const started = performance.now();
    const lost = await Promise.race([
      once(handle.signal, 'abort').then(() => 'lost' as const),
      delay(2000, 'still held' as const),
    ]);
    const after = performance.now() - started;

    // Assert: one interval to the next heartbeat, one interval for its answer.
    assert.equal(
      lost,
      'lost',
      'The holder must learn that its session may be gone',
    );
    assert.ok(handle.signal.reason instanceof LeaseLostError);
    assert.ok(
      after < 2 * heartbeatInterval + 150,
      `The lease was lost ${after.toFixed(0)} ms after the partition, later than two heartbeat intervals`,
    );
  },
);

test(
  'a held key is lost at once when the server kills its session',
  { timeout: 60_000 },
  async () => {
    // Arrange: a heartbeat far away, so only the end of the session can tell the holder.
    await using database = await sqlServerDatabase();
    const store = new SqlServerStore({
      connect: () => sessionTo(database, database),
      sequence,
      heartbeatInterval: 30_000,
    });
    const handle = await store.acquire('report:daily');
    const [holder] = await observe(
      database,
      `SELECT request_session_id AS id FROM sys.dm_tran_locks
       WHERE resource_type = N'APPLICATION' AND resource_database_id = DB_ID() AND request_status = N'GRANT'`,
    );

    // Act: listen first, because the end of the session can arrive before the KILL answers.
    const aborted = once(handle.signal, 'abort');
    await observe(database, `KILL ${Number(holder?.id)}`);
    const lost = await Promise.race([
      aborted.then(() => 'lost' as const),
      delay(2000, 'still held' as const),
    ]);

    // Assert
    assert.equal(lost, 'lost', 'The holder must learn that its session ended');
    assert.ok(handle.signal.reason instanceof LeaseLostError);
  },
);
