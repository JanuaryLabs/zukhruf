import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';

import mysql, { type RowDataPacket } from 'mysql2/promise';

import { waitFor } from '../async/wait-for.ts';
import { DockerTestbed } from '../docker/index.ts';
import { slowProxy } from '../testing/slow-proxy.ts';
import { Mysql, type MysqlDatabase, mysqlPool } from './mysql.ts';

const docker = new DockerTestbed({ environment: process.env });
test('a dedicated MySQL server gives a driver its requested database and leaves with its container', async (t) => {
  const database = `owned_${randomUUID().replaceAll('-', '')}`;
  const server = await new Mysql({
    environment: process.env,
    database,
  }).start();
  const id = server.containerId;
  {
    await using owned = server;
    const client = await docker.client();
    const image = (await (await client.containers.find(id))?.inspect())?.Config
      ?.Image;
    assert.equal(image, 'mysql:lts');
    assert.equal(owned.image, image);
    assert.equal(new URL(owned.connectionString).protocol, 'mysql:');
    {
      await using connection = await mysql.createConnection(
        owned.connectionString,
      );

      const [[row]] = await connection.query<RowDataPacket[]>(
        'SELECT DATABASE() AS name',
      );
      assert.equal(row?.name, database);
    }
    assert.deepEqual(await owned.query('SELECT 42 AS value, NULL AS missing'), [
      { value: '42', missing: null },
    ]);
  }
  await waitFor(
    async () => {
      const client = await docker.client();
      assert.equal(await client.containers.find(id), undefined);
    },
    { signal: t.signal },
  );
});

const mysqlServer = new Mysql({ environment: process.env });

/** The sessions on the server of `observer` whose database is `name`, and whether that database exists. */
async function serverState(observer: MysqlDatabase, name: string) {
  const [[row]] = await observer.pool().query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE DB = ?) AS sessions,
       (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?) AS found`,
    [name, name],
  );
  return {
    sessions: Number(row?.['sessions']),
    exists: Number(row?.['found']) === 1,
  };
}

test('the disposal of a database waits until the server has closed every connection of its pools, and then drops the database', async () => {
  // Arrange: four idle connections of a pool that reaches the server through a proxy that forwards their Quit 1 s late.
  await using observer = await mysqlServer.database();
  await using proxy = await slowProxy(observer);
  let name: string;
  {
    await using database = await mysqlServer.database();
    name = database.database;
    const pool = database.pool({
      host: proxy.host,
      port: proxy.port,
      connectionLimit: 4,
    });
    const connections = await Promise.all(
      Array.from({ length: 4 }, () => pool.getConnection()),
    );
    for (const connection of connections) connection.release();
    assert.equal(
      proxy.connections(),
      4,
      'The pool must reach the server through the proxy',
    );
    proxy.slowDown(1_000);

    // Act: the end of the scope disposes the database.
  }

  // Assert
  assert.deepEqual(await serverState(observer, name), {
    sessions: 0,
    exists: false,
  });
});

test('the disposal of a database destroys the connections that are still checked out, drops the database, and then rejects with their count', async (t) => {
  // Arrange: one leaked connection is idle, one waits for a lock that another session holds, and the test destroyed a third.
  await using observer = await mysqlServer.database();
  const lock = randomUUID();
  await using holder = await observer.pool().getConnection();
  await holder.query('SELECT GET_LOCK(?, 0)', [lock]);
  const database = await mysqlServer.database();
  const pool = database.pool();
  await pool.getConnection();
  const waiter = await pool.getConnection();
  void waiter.query('SELECT GET_LOCK(?, 600)', [lock]).catch(() => {});
  await waitFor(
    async () => {
      const [[row]] = await holder.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS waiting FROM information_schema.PROCESSLIST
         WHERE ID = ? AND STATE = 'User lock'`,
        [waiter.threadId],
      );
      assert.equal(Number(row?.['waiting']), 1);
    },
    { signal: t.signal },
  );
  (await pool.getConnection()).destroy();

  // Act
  const disposal = database.cleanup();

  // Assert
  await assert.rejects(disposal, {
    message:
      'The disposal destroyed 2 connections of a pool of this database that were still checked out.',
  });
  assert.deepEqual(await serverState(observer, database.database), {
    sessions: 0,
    exists: false,
  });
});

test('a MySQL database whose disposal started gives no pool', async () => {
  // Arrange
  const database = await mysqlServer.database();
  await database[Symbol.asyncDispose]();

  // Act & Assert
  assert.throws(() => database.pool(), {
    message: 'The disposal of this database has started.',
  });
});

test('a dedicated MySQL server ends the pools of its handle before it removes its container', async () => {
  // Arrange
  const errors: Error[] = [];
  {
    await using server = await new Mysql({ environment: process.env }).start();
    const pool = server.pool({ connectionLimit: 3 });
    const connections = await Promise.all(
      Array.from({ length: 3 }, () => pool.getConnection()),
    );
    for (const connection of connections) {
      connection.connection.on('error', (error: Error) => errors.push(error));
      connection.release();
    }

    // Act: the end of the scope disposes the server.
  }

  // Assert
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    'A connection of the pool lost its server while the container was removed',
  );
});

test("mysqlPool's disposal resolves once the server has closed every connection of its pool", async () => {
  // Arrange: three idle connections.
  await using database = await mysqlServer.database();
  const helper = mysqlPool({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.database,
  });
  const connections = await Promise.all(
    Array.from({ length: 3 }, () => helper.pool.getConnection()),
  );
  const closed = new Set<unknown>();
  for (const connection of connections) {
    connection.connection.once('end', () => closed.add(connection));
    connection.release();
  }

  // Act
  await helper[Symbol.asyncDispose]();

  // Assert
  assert.equal(closed.size, connections.length);
});

test("mysqlPool's disposal destroys a connection that is still checked out, and rejects with the count", async () => {
  // Arrange
  await using database = await mysqlServer.database();
  const helper = mysqlPool({ uri: database.connectionString });
  const leaked = await helper.pool.getConnection();
  const ended = once(leaked.connection, 'end');

  // Act & Assert
  await assert.rejects(async () => helper[Symbol.asyncDispose](), {
    message:
      'The disposal destroyed 1 connection of a pool that was still checked out.',
  });
  await ended;
});

// Compile-only assertions: deliberately invalid calls must never execute.
async function checkTypes(database: MysqlDatabase) {
  const pool = database.pool();
  // @ts-expect-error The disposal of the handle ends the pool, not `await using`.
  await using ended = pool;
  // @ts-expect-error The disposal of the handle ends the pool, not the test.
  await pool.end();
  // @ts-expect-error The callback pool would end it too.
  pool.pool.end();
  // @ts-expect-error The handle names the database of its pools.
  database.pool({ database: 'other' });
  void ended;
}
void checkTypes;
