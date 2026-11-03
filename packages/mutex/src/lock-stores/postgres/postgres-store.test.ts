import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';

import pg from 'pg';

import { Postgres } from '@zukhruf/testing/postgres';

import { Modes, Mutex } from '../../index.ts';
import type { Subject } from '../../testing/contract/subject.ts';
import { hold } from '../../testing/hold.ts';
import {
  postgresPool,
  subject as postgresSubject,
} from '../../testing/subjects/postgres.ts';
import { PostgresStore } from './index.ts';

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
    clock: globalThis,
  });

test('a role with only USAGE on the sequence can acquire', async () => {
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
});

/**
 * One test of the shared store suites over the PostgresStore case: four
 * holders and a skipped try give the host's pool five sessions, then the host
 * is disposed. Returns how many sessions the server still has on the
 * fixture's database at that moment, before the fixture drops it.
 */
async function sessionsAfterTheHostIsDisposed(
  postgresSubject: Subject,
): Promise<number> {
  await using fixture = await postgresSubject.fixture(process.env);
  // Connected before the host opens, so the count is read right after the disposal.
  const server = new URL(fixture.location);
  const database = decodeURIComponent(server.pathname.slice(1));
  server.pathname = '/postgres';
  const observer = new pg.Client({ connectionString: server.toString() });
  await observer.connect();
  try {
    {
      await using host = postgresSubject.open(fixture.location);
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
    // An autovacuum worker on the database is a backend too, not a session of
    // the pool.
    const { rows } = await observer.query(
      "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'",
      [database],
    );
    return rows[0].sessions;
  } finally {
    await observer.end();
  }
}

test("a disposed PostgresStore case host leaves no session of its pool on the server, so the fixture's drop cannot end a connection the pool still owns", async () => {
  // Arrange: the case of the shared store suites. A session left behind is a race, so the cycle runs many times.
  const cycles = 25;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    // Act
    const sessions = await sessionsAfterTheHostIsDisposed(postgresSubject);

    // Assert
    assert.equal(
      sessions,
      0,
      `Cycle ${cycle} of ${cycles}: ${sessions} session(s) of the disposed host's pool were still on the server`,
    );
  }
});

test("postgresPool's disposal resolves only after every client of its pool has ended, including one that was checked out when the disposal began", async () => {
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
});

test('a pool of postgresPool has no end, so its disposal is the only way to end it', () => {
  // A function that is never called: the type checker reads it.
  const end = (helper: ReturnType<typeof postgresPool>) =>
    // @ts-expect-error a helper pool has no end; its disposal is the only end (#3305).
    helper.pool.end();
  assert.equal(typeof end, 'function');
});
