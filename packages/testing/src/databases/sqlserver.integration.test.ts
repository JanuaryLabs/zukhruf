import assert from 'node:assert/strict';
import { test } from 'node:test';

import type sql from 'mssql';

import { waitFor } from '../async/wait-for.ts';
import { slowProxy } from '../testing/slow-proxy.ts';
import { SqlServer, type SqlServerDatabase } from './sqlserver.ts';

const sqlServer = new SqlServer({ environment: process.env });

/** A tedious connection of a pool, as tarn gives it. */
type PoolConnection = Parameters<sql.ConnectionPool['pool']['release']>[0];

/** Whether the server of `observer` has a database named `name`. */
async function exists(
  observer: SqlServerDatabase,
  name: string,
): Promise<boolean> {
  const pool = await observer.pool();
  const { recordset } = await pool
    .request()
    .input('name', name)
    .query<{ id: number | null }>('SELECT DB_ID(@name) AS id');
  return recordset[0]?.id !== null;
}

/** Records each connection that `pool` makes from now on, and each error of the pool and of its connections. */
function watch(pool: sql.ConnectionPool) {
  const errors: Error[] = [];
  const connections: PoolConnection[] = [];
  pool.on('error', (error: Error) => errors.push(error));
  pool.pool.on('createSuccess', (_id, connection) => {
    connections.push(connection);
    connection.on('error', (error) => errors.push(error));
  });
  return { errors, connections };
}

/** Runs `count` statements at once, so the pool makes `count` connections. */
const busy = (pool: sql.ConnectionPool, count: number) =>
  Promise.all(
    Array.from({ length: count }, () =>
      pool.request().query("WAITFOR DELAY '00:00:00.200'"),
    ),
  );

test('the disposal of a SQL Server database closes every connection of its pools before the drop, so no connection gets the error of the drop', async () => {
  // Arrange: four idle connections of a pool that reaches the server through a proxy that forwards their goodbye 1 s late.
  await using observer = await sqlServer.database();
  await using proxy = await slowProxy(observer);
  let name: string;
  let watched: ReturnType<typeof watch>;
  {
    await using database = await sqlServer.database();
    name = database.database;
    const pool = await database.pool({
      server: proxy.host,
      port: proxy.port,
      pool: { max: 4 },
    });
    watched = watch(pool);
    await busy(pool, 4);
    assert.equal(
      proxy.connections(),
      5,
      'The pool must reach the server through the proxy: the probe of connect() and four connections',
    );
    proxy.slowDown(1_000);

    // Act: the end of the scope disposes the database.
  }

  // Assert
  assert.deepEqual(
    watched.errors.map((error) => error.message),
    [],
    'A connection of the pool got an error while the database was dropped',
  );
  assert.deepEqual(
    watched.connections.map((connection) => connection.closed),
    [true, true, true, true],
  );
  assert.equal(await exists(observer, name), false);
});

test('the disposal of a SQL Server database closes the connections that are still checked out, drops the database, and then rejects with their count', async (t) => {
  // Arrange: one leaked connection holds a transaction, and one waits in a statement that does not end.
  await using observer = await sqlServer.database();
  const database = await sqlServer.database();
  const pool = await database.pool({ requestTimeout: 0 });
  await pool.transaction().begin();
  const waiting = pool
    .request()
    .query("WAITFOR DELAY '00:10:00'")
    .catch((error: unknown) => error);
  await waitFor(() => assert.equal(pool.borrowed, 2), { signal: t.signal });

  // Act
  const disposal = database.cleanup();

  // Assert
  await assert.rejects(disposal, {
    message:
      'The disposal destroyed 2 connections of a pool of this database that were still checked out.',
  });
  assert.ok(Error.isError(await waiting));
  assert.equal(await exists(observer, database.database), false);
});

test('the disposal of a SQL Server database does not fail when the test closed a pool itself', async () => {
  // Arrange
  await using observer = await sqlServer.database();
  let name: string;
  {
    await using database = await sqlServer.database();
    name = database.database;
    const pool = await database.pool();
    await pool.request().query('SELECT 1');
    await pool.close();

    // Act: the end of the scope disposes the database.
  }

  // Assert: the disposal resolved.
  assert.equal(await exists(observer, name), false);
});

test('a SQL Server database whose disposal started gives no pool', async () => {
  // Arrange
  const database = await sqlServer.database();
  await database[Symbol.asyncDispose]();

  // Act & Assert
  await assert.rejects(database.pool(), {
    message: 'The disposal of this database has started.',
  });
});

test('a dedicated SQL Server closes the pools of its handle before it removes its container', async () => {
  // Arrange
  let watched: ReturnType<typeof watch>;
  {
    await using server = await new SqlServer({
      environment: process.env,
    }).start();
    const pool = await server.pool({ pool: { max: 3 } });
    watched = watch(pool);
    await busy(pool, 3);

    // Act: the end of the scope disposes the server.
  }

  // Assert
  assert.deepEqual(
    watched.errors.map((error) => error.message),
    [],
    'A connection of the pool lost its server while the container was removed',
  );
  assert.deepEqual(
    watched.connections.map((connection) => connection.closed),
    [true, true, true],
  );
});

// Compile-only assertions: deliberately invalid calls must never execute.
async function checkTypes(database: SqlServerDatabase) {
  // A store that takes a ConnectionPool, and tests instanceof, takes it.
  const pool: sql.ConnectionPool = await database.pool();
  // @ts-expect-error The disposal of the handle closes the pool, not `await using`.
  await using closed = await database.pool();
  // @ts-expect-error The handle names the database of its pools.
  await database.pool({ database: 'other' });
  // @ts-expect-error The tedious options cannot name another database either.
  await database.pool({ options: { database: 'other' } });
  // @ts-expect-error The handle names the user of its pools.
  await database.pool({ user: 'other' });
  // @ts-expect-error The pool is there once the promise resolves, connected.
  database.pool().request();
  void pool;
  void closed;
}
void checkTypes;
