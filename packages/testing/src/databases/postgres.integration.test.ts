import assert from 'node:assert/strict';
import { once } from 'node:events';

import { test } from '@zukhruf/parameterized-test';

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

test('a server takes more WAL than its disk holds, since it checkpoints before the WAL fills the disk', async () => {
  // Arrange: a dedicated server, so a full disk cannot stop the shared one.
  await using server = await postgres.start();
  const pool = server.pool();
  await pool.query('CREATE EXTENSION pg_trgm');
  await pool.query(
    'CREATE TABLE code (id int PRIMARY KEY, name text NOT NULL)',
  );
  await pool.query('CREATE INDEX ON code USING gin (name gin_trgm_ops)');

  // Act: three loads of 74,879 rows, as many as ICD-10-CM has, write about 660 MB of WAL, more than the 512 MB disk.
  for (let load = 0; load < 3; load++) {
    await pool.query(
      `INSERT INTO code
       SELECT i, md5(i::text) || ' ' || md5((i * 7)::text)
       FROM generate_series($1::int, $1::int + 74878) AS i`,
      [load * 74_879],
    );
  }

  // Assert: the loads resolved, so no write failed with "No space left on device".
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM code');
  assert.equal(rows[0].n, 3 * 74_879);
});

/** The size in KiB of the filesystem at `path` inside the server of `server`. */
async function diskKib(
  server: PostgresDatabase,
  path: string,
): Promise<number> {
  const client = await server.pool().connect();
  try {
    await client.query('CREATE TEMP TABLE df (line text)');
    await client.query(`COPY df FROM PROGRAM 'df -kP ${path} | tail -n 1'`);
    const { rows } = await client.query('SELECT line FROM df');
    return Number(rows[0].line.split(/\s+/)[1]);
  } finally {
    client.release();
  }
}

/** The max_wal_size of the server of `server`. */
async function maxWalSize(server: PostgresDatabase): Promise<string> {
  const { rows } = await server.pool().query('SHOW max_wal_size');
  return rows[0].max_wal_size;
}

test('a dedicated server whose tmpFs sizes its data directory gets that disk and a quarter of it as max_wal_size', async () => {
  // Arrange
  const sized = new Postgres({
    environment: process.env,
    tmpFs: { '/var/lib/postgresql': 'rw,size=1g' },
  });

  // Act
  await using server = await sized.start();

  // Assert
  assert.equal(await diskKib(server, '/var/lib/postgresql'), 1024 ** 2);
  assert.equal(await maxWalSize(server), '256MB');
});

test('a dedicated server without tmpFs keeps the 512 MB data directory and 128 MB of WAL', async () => {
  // Act
  await using server = await postgres.start();

  // Assert
  assert.equal(await diskKib(server, '/var/lib/postgresql'), 512 * 1024);
  assert.equal(await maxWalSize(server), '128MB');
});

test("a data directory mount with no size=, or size=0, keeps Postgres's default max_wal_size", async () => {
  // Arrange
  const unsized = new Postgres({
    environment: process.env,
    tmpFs: { '/var/lib/postgresql': 'rw' },
  });
  const unlimited = new Postgres({
    environment: process.env,
    tmpFs: { '/var/lib/postgresql': 'rw,size=0' },
  });

  // Act
  await using server = await unsized.start();
  await using other = await unlimited.start();

  // Assert: Linux gives a tmpfs with no size= half the RAM, so only "not 512 MiB" is fixed.
  assert.notEqual(await diskKib(server, '/var/lib/postgresql'), 512 * 1024);
  assert.equal(await maxWalSize(server), '1GB');
  assert.equal(await maxWalSize(other), '1GB');
});

test('the last size= of the data directory mount counts, with its suffix in either case', async () => {
  // Arrange: a tmpfs reserves no memory, so a 1 TiB limit is only a limit.
  const sized = new Postgres({
    environment: process.env,
    tmpFs: { '/var/lib/postgresql': 'rw,size=64m,size=1T' },
  });

  // Act
  await using server = await sized.start();

  // Assert
  assert.equal(await diskKib(server, '/var/lib/postgresql'), 1024 ** 3);
  assert.equal(await maxWalSize(server), '256GB');
});

test("a tmpFs mount at another path adds that mount and keeps the data directory's", async () => {
  // Arrange
  const scratch = new Postgres({
    environment: process.env,
    tmpFs: { '/scratch': 'rw,size=64m' },
  });

  // Act
  await using server = await scratch.start();

  // Assert
  assert.equal(await diskKib(server, '/scratch'), 64 * 1024);
  assert.equal(await diskKib(server, '/var/lib/postgresql'), 512 * 1024);
  assert.equal(await maxWalSize(server), '128MB');
});

test('a database() with tmpFs is on another shared server than a database() without it', async () => {
  // Arrange: a mount at another path keeps max_wal_size, so only the mounts differ.
  const scratch = new Postgres({
    environment: process.env,
    tmpFs: { '/scratch': 'rw,size=64m' },
  });

  // Act
  await using plain = await postgres.database();
  await using other = await scratch.database();

  // Assert
  assert.notEqual(other.containerId, plain.containerId);
  assert.equal(await diskKib(other, '/scratch'), 64 * 1024);
});

void test.each(['10%', '1gb'], (size) =>
  test(`a data directory size=${size} is refused, since Postgres gets no max_wal_size from it`, () => {
    // Act & Assert
    assert.throws(
      () =>
        new Postgres({
          environment: process.env,
          tmpFs: { '/var/lib/postgresql': `rw,size=${size}` },
        }),
      {
        name: 'TypeError',
        message: `The size=${size} of /var/lib/postgresql is not a number of bytes with an optional k, m, g, t, p or e, so it gives no max_wal_size.`,
      },
    );
  }),
);

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
