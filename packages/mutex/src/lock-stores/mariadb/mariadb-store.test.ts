import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import mariadb, { type Pool, type PoolConfig } from 'mariadb';

import { Mariadb, type MariadbDatabase } from '@zukhruf/testing/mariadb';

import { Mutex } from '../../index.ts';
import { uniqueKey } from '../../testing/contract/keys.ts';
import { hold } from '../../testing/hold.ts';
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
  {
    await using owner = await mariadb.createConnection(connectionOf(database));

    await owner.query(`CREATE SEQUENCE ${sequence}`);
  }
  return database;
}

const poolOf = (database: MariadbDatabase, options: PoolConfig = {}) =>
  mariadb.createPool({ ...connectionOf(database), ...options });

const storeOver = (pool: Pool) =>
  new MariadbStore({
    connect: () => pool.getConnection(),
    sequence,
    heartbeatInterval,
    clock: globalThis,
  });

test('a wait outlasts the max_statement_time of its session', async () => {
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
      clock: globalThis,
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
});

test('a key longer than 192 characters is a lock', async () => {
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
});

test('a user with only SELECT and INSERT on the sequence can acquire', async () => {
  // Arrange: root made the sequence; the app's user may read and advance it, and create nothing.
  await using database = await mariadbDatabase();
  const user = `mutex_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = await mariadb.createConnection(connectionOf(database));
  try {
    await owner.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'app'`);
    await owner.query(
      `GRANT SELECT, INSERT ON \`${database.database}\`.${sequence} TO '${user}'@'%'`,
    );

    await using pool = poolOf(database, { user, password: 'app' });

    // Act
    const token = await new Mutex(storeOver(pool)).acquire(
      uniqueKey(),
      async (lease) => lease.token,
    );

    // Assert
    assert.equal(token.value, 1n);
  } finally {
    // A user belongs to the server, not to the database of the test.
    await owner.query(`DROP USER '${user}'@'%'`);
    await owner.end();
  }
});
