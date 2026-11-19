import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { slowProxy } from '../testing/slow-proxy.ts';
import { Postgres, type PostgresDatabase, postgresPool } from './postgres.ts';

const postgres = new Postgres({ environment: process.env });

/** Whether the server of `observer` has a database named `name`. */
async function exists(
  observer: PostgresDatabase,
  name: string,
): Promise<boolean> {
  const { rows } = await observer
    .pool()
    .query('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [
      name,
    ]);
  return rows[0].n === 1;
}

test('the disposal of a database waits until every client of its pools has closed before the drop, so no client gets the error of the drop', async () => {
  // Arrange: four idle clients of a pool that reaches the server through a proxy that forwards their goodbye 1 s late.
  await using observer = await postgres.database();
  await using proxy = await slowProxy(observer);
  const errors: Error[] = [];
  let name: string;
  {
    await using database = await postgres.database();
    name = database.database;
    const pool = database.pool({ host: proxy.host, port: proxy.port, max: 4 });
    pool.on('error', (error) => errors.push(error));
    const clients = await Promise.all(
      Array.from({ length: 4 }, () => pool.connect()),
    );
    for (const client of clients) client.release();
    assert.equal(
      proxy.connections(),
      4,
      'The pool must reach the server through the proxy',
    );
    proxy.slowDown(1_000);

    // Act: the end of the scope disposes the database.
  }

  // Assert
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    'A client of the pool got an error while the database was dropped',
  );
  assert.equal(await exists(observer, name), false);
});

test('the disposal of a database does not end a pool again when the test ended it', async () => {
  // Arrange
  await using observer = await postgres.database();
  let name: string;
  {
    await using database = await postgres.database();
    name = database.database;
    const pool = database.pool();
    await pool.query('SELECT 1');
    await pool.end();

    // Act: the end of the scope disposes the database.
  }

  // Assert: the disposal resolved, so it did not reject "Called end on pool more than once".
  assert.equal(await exists(observer, name), false);
});

test('the disposal of a database destroys the clients that are still checked out, drops the database, and then rejects with their count', async () => {
  // Arrange: one leaked client is idle, and one waits in a query that does not end.
  await using observer = await postgres.database();
  const database = await postgres.database();
  const pool = database.pool();
  await pool.connect();
  const busy = await pool.connect();
  const sleeping = busy.query('SELECT pg_sleep(600)').catch((error) => error);

  // Act
  const disposal = database.cleanup();

  // Assert
  await assert.rejects(disposal, {
    message:
      'The disposal destroyed 2 clients of a pool of this database that were still checked out.',
  });
  assert.ok(Error.isError(await sleeping));
  assert.equal(await exists(observer, database.database), false);
});

test('a database whose disposal started gives no pool', async () => {
  // Arrange
  const database = await postgres.database();
  await database[Symbol.asyncDispose]();

  // Act & Assert
  assert.throws(() => database.pool(), {
    message: 'The disposal of this database has started.',
  });
});

test('a dedicated server ends the pools of its handle before it removes its container', async () => {
  // Arrange
  const errors: Error[] = [];
  {
    await using server = await new Postgres({
      environment: process.env,
    }).start();
    const pool = server.pool({ max: 3 });
    pool.on('error', (error) => errors.push(error));
    const clients = await Promise.all(
      Array.from({ length: 3 }, () => pool.connect()),
    );
    for (const client of clients) client.release();

    // Act: the end of the scope disposes the server.
  }

  // Assert
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    'A client of the pool got an error while the container was removed',
  );
});

test("postgresPool's disposal resolves once every client of its pool has closed", async () => {
  // Arrange: three idle clients.
  await using database = await postgres.database();
  const helper = postgresPool({
    connectionString: database.connectionString,
  });
  const clients = await Promise.all(
    Array.from({ length: 3 }, () => helper.pool.connect()),
  );
  const closed = new Set<unknown>();
  for (const client of clients) client.once('end', () => closed.add(client));
  for (const client of clients) client.release();

  // Act
  await helper[Symbol.asyncDispose]();

  // Assert
  assert.equal(closed.size, clients.length);
});

test("postgresPool's disposal destroys a client that is still checked out, and rejects with the count", async () => {
  // Arrange
  await using database = await postgres.database();
  const helper = postgresPool({
    connectionString: database.connectionString,
  });
  const leaked = await helper.pool.connect();
  const ended = once(leaked, 'end');

  // Act & Assert
  await assert.rejects(async () => helper[Symbol.asyncDispose](), {
    message:
      'The disposal destroyed 1 client of a pool that was still checked out.',
  });
  await ended;
});
