import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import mysql from 'mysql2/promise';

import { Mysql, type MysqlDatabase } from '@zukhruf/testing/mysql';

import { Mutex } from '../../index.ts';
import { uniqueKey } from '../../testing/contract/keys.ts';
import { hold } from '../../testing/hold.ts';
import { MysqlStore } from './index.ts';

/**
 * The first tests are design errors that the probes of MysqlStore found. The
 * name of each test says what the wrong design broke. The last tests are the
 * contract of a lock store.
 */

const table = 'mutex_tokens';
const heartbeatInterval = 200;

/** A new database with the token table that the app creates before it starts. */
async function mysqlDatabase() {
  const database = await new Mysql({ environment: process.env }).database();
  const owner = await mysql.createConnection(database.connectionString);
  try {
    await owner.query(`CREATE TABLE ${table} (id BIGINT UNSIGNED NOT NULL)`);
    await owner.query(`INSERT INTO ${table} VALUES (0)`);
  } finally {
    await owner.end();
  }
  return database;
}

const poolOf = (database: MysqlDatabase, options: mysql.PoolOptions = {}) =>
  mysql.createPool({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.database,
    ...options,
  });

const storeOver = (pool: mysql.Pool) =>
  new MysqlStore({
    connect: () => pool.getConnection(),
    table,
    heartbeatInterval,
    clock: globalThis,
  });

test('a wait outlasts the max_execution_time of its session', async () => {
  // Arrange: the app's sessions stop each SELECT after 300 ms.
  await using database = await mysqlDatabase();
  const holderPool = poolOf(database);
  const waiterPool = poolOf(database);
  const key = uniqueKey();
  try {
    const holder = await hold(new Mutex(storeOver(holderPool)), key);
    const waiter = new MysqlStore({
      connect: async () => {
        const session = await waiterPool.getConnection();
        await session.query('SET SESSION max_execution_time = 300');
        return session;
      },
      table,
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

test('a key longer than 64 characters is a lock', async () => {
  // Arrange
  await using database = await mysqlDatabase();
  const pool = poolOf(database);
  const key = `${'report:'.repeat(20)}${randomUUID()}`;
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

test('a token table without its row fails the acquire instead of repeating a token', async () => {
  // Arrange: the row of the token table is gone, and the session already gave a token.
  await using database = await mysqlDatabase();
  const pool = poolOf(database, { connectionLimit: 1 });
  const mutex = new Mutex(storeOver(pool));
  const key = uniqueKey();
  try {
    await mutex.acquire(key, async () => {});
    const owner = await mysql.createConnection(database.connectionString);
    await owner.query(`DELETE FROM ${table}`);
    await owner.end();

    // Act
    const acquired = mutex.acquire(key, async (lease) => lease.token);

    // Assert
    await assert.rejects(
      acquired,
      /exactly one row/,
      'A token table with no row must not give the token of the last grant again',
    );
    assert.equal(
      await storeOver(pool).isHeld(key),
      false,
      'A failed token must release the key',
    );
  } finally {
    await pool.end();
  }
});

test('a user with only SELECT and UPDATE on the token table can acquire', async () => {
  // Arrange: root made the table; the app's user may read and update it, and create nothing.
  await using database = await mysqlDatabase();
  const user = `mutex_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = await mysql.createConnection(database.connectionString);
  try {
    await owner.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'app'`);
    await owner.query(
      `GRANT SELECT, UPDATE ON \`${database.database}\`.${table} TO '${user}'@'%'`,
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
});
