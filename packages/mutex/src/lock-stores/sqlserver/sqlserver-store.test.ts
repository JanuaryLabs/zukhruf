import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Connection, Request, TYPES } from 'tedious';

import { type Database, SqlServer } from '@zukhruf/testing/sqlserver';

import { type Endpoint } from '../../testing/tcp-proxy.ts';
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
    clock: globalThis,
  });

test('the tokens of later grants are larger, across stores', async () => {
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
});

test('a key is free for another store as soon as its release resolves', async () => {
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
      clock: globalThis,
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
});

test('two keys that differ only after 255 characters are two locks', async () => {
  // Arrange: sp_getapplock cuts a longer resource name to 255 characters.
  await using database = await sqlServerDatabase();
  const prefix = 'k'.repeat(255);
  await using _ = await storeOver(database).acquire(`${prefix}:a`);

  // Act
  const other = await storeOver(database).tryAcquire(`${prefix}:b`);

  // Assert
  assert.ok(other, 'A key must not wait for another key');
  await other[Symbol.asyncDispose]();
});
