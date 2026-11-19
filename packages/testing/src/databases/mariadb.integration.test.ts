import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import mariadb from 'mariadb';

import { waitFor } from '../async/wait-for.ts';
import { DockerTestbed } from '../docker/index.ts';
import { slowProxy } from '../testing/slow-proxy.ts';
import { Mariadb, type MariadbDatabase, mariadbPool } from './mariadb.ts';

const docker = new DockerTestbed({ environment: process.env });
test('a dedicated MariaDB server gives the official driver its requested database and leaves with its container', async (t) => {
  const database = `owned_${randomUUID().replaceAll('-', '')}`;
  const server = await new Mariadb({
    environment: process.env,
    database,
  }).start();
  const id = server.containerId;
  {
    await using owned = server;
    const client = await docker.client();
    const image = (await (await client.containers.find(id))?.inspect())?.Config
      ?.Image;
    assert.equal(image, 'mariadb:lts');
    assert.equal(owned.image, image);
    {
      await using connection = await mariadb.createConnection(
        owned.connectionString,
      );

      const [row] = await connection.query(
        'SELECT VERSION() AS version, DATABASE() AS name',
      );
      assert.match(row.version, /MariaDB/);
      assert.equal(row.name, database);
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

const mariadbServer = new Mariadb({ environment: process.env });

/**
 * The sessions on the server of `observer` whose database is `name`, or only
 * those whose id is in `ids`, and whether the database `name` exists.
 */
async function serverState(
  observer: MariadbDatabase,
  name: string,
  ids?: (number | null)[],
) {
  const [row] = await observer.pool().query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.PROCESSLIST
          WHERE ${ids === undefined ? 'DB = ?' : 'ID IN (?)'}) AS sessions,
       (SELECT COUNT(*) FROM information_schema.SCHEMATA
          WHERE SCHEMA_NAME = ?) AS found`,
    [ids ?? name, name],
  );
  return { sessions: Number(row.sessions), exists: Number(row.found) === 1 };
}

/** Waits until the session `id` waits for a user lock. */
async function untilItWaits(
  observer: MariadbDatabase,
  id: number | null,
  signal: AbortSignal,
) {
  await waitFor(
    async () => {
      const [row] = await observer.pool().query(
        `SELECT COUNT(*) AS waiting FROM information_schema.PROCESSLIST
           WHERE ID = ? AND STATE = 'User lock'`,
        [id],
      );
      assert.equal(Number(row.waiting), 1);
    },
    { signal },
  );
}

test('the disposal of a database waits until the server has ended each connection that is still checked out, and then drops the database', async (t) => {
  // Arrange: a leaked connection waits for a lock, through a proxy that forwards what clients send 1 s late.
  await using observer = await mariadbServer.database();
  await using proxy = await slowProxy(observer);
  const lock = randomUUID();
  await using holder = await observer.pool().getConnection();
  await holder.query('SELECT GET_LOCK(?, 0)', [lock]);
  const database = await mariadbServer.database();
  // The kill connects through the proxy too, so its handshake takes seconds.
  const pool = database.pool({
    host: proxy.host,
    port: proxy.port,
    connectTimeout: 30_000,
  });
  const waiter = await pool.getConnection();
  void waiter.query('SELECT GET_LOCK(?, 600)', [lock]).catch(() => {});
  await untilItWaits(observer, waiter.threadId, t.signal);
  proxy.slowDown(1_000);

  // Act
  const disposal = database.cleanup();

  // Assert
  await assert.rejects(disposal, {
    message:
      'The disposal destroyed 1 connection of a pool of this database that was still checked out.',
  });
  // Only the leaked session: mariadb destroys an idle socket right after COM_QUIT, so the proxy still holds the goodbye of the idle ones.
  assert.deepEqual(
    await serverState(observer, database.database, [waiter.threadId]),
    { sessions: 0, exists: false },
  );
});

test('the disposal of a MariaDB database ends the connections that are still checked out, drops the database, and then rejects with their count', async (t) => {
  // Arrange: one leaked connection is idle, one waits for a lock that another session holds, and the test destroyed a third.
  await using observer = await mariadbServer.database();
  const lock = randomUUID();
  await using holder = await observer.pool().getConnection();
  await holder.query('SELECT GET_LOCK(?, 0)', [lock]);
  const database = await mariadbServer.database();
  const pool = database.pool();
  await pool.getConnection();
  const waiter = await pool.getConnection();
  void waiter.query('SELECT GET_LOCK(?, 600)', [lock]).catch(() => {});
  await untilItWaits(observer, waiter.threadId, t.signal);
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

test('a MariaDB database whose disposal started gives no pool', async () => {
  // Arrange
  const database = await mariadbServer.database();
  await database[Symbol.asyncDispose]();

  // Act & Assert
  assert.throws(() => database.pool(), {
    message: 'The disposal of this database has started.',
  });
});

test('a dedicated MariaDB server ends the pools of its handle before it removes its container', async () => {
  // Arrange
  const errors: Error[] = [];
  {
    await using server = await new Mariadb({
      environment: process.env,
    }).start();
    const pool = server.pool({ connectionLimit: 3 });
    const connections = await Promise.all(
      Array.from({ length: 3 }, () => pool.getConnection()),
    );
    for (const connection of connections) {
      connection.on('error', (error) => errors.push(error));
      await connection.release();
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

test("mariadbPool's disposal ends a connection that is still checked out, and rejects with the count", async () => {
  // Arrange
  await using observer = await mariadbServer.database();
  await using database = await mariadbServer.database();
  const helper = mariadbPool({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.database,
  });
  const leaked = await helper.pool.getConnection();

  // Act & Assert
  await assert.rejects(async () => helper[Symbol.asyncDispose](), {
    message:
      'The disposal destroyed 1 connection of a pool that was still checked out.',
  });
  assert.deepEqual(
    await serverState(observer, database.database, [leaked.threadId]),
    { sessions: 0, exists: true },
  );
});

// Compile-only assertions: deliberately invalid calls must never execute.
async function checkTypes(database: MariadbDatabase) {
  const pool = database.pool();
  // @ts-expect-error The disposal of the handle ends the pool, not `await using`.
  await using ended = pool;
  // @ts-expect-error The disposal of the handle ends the pool, not the test.
  await pool.end();
  // @ts-expect-error The handle names the user of its pools.
  database.pool({ user: 'other' });
  void ended;
}
void checkTypes;
