import assert from 'node:assert/strict';
import { test } from 'node:test';

import type pg from 'pg';

import { Postgres } from '@zukhruf/testing/postgres';

import { ConsumerGroup, CorruptCheckpointError } from '../index.ts';
import { PostgresCheckpointStore, type PostgresSession } from '../postgres.ts';
import { checkpointStoreWriteContract } from '../testing/contract/checkpoint-store-write.ts';
import { checkpointStoreContract } from '../testing/contract/checkpoint-store.ts';
import { position } from '../testing/formats.ts';

// The session a host writes over node-postgres: queries on the pool, and a
// transaction on one client of it.
const session = (pool: pg.Pool): PostgresSession => ({
  query: async (sql, parameters) =>
    (await pool.query(sql, [...parameters])).rows,
  transaction: async (work) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inner: PostgresSession = {
        query: async (sql, parameters) =>
          (await client.query(sql, [...parameters])).rows,
        transaction: async (nested) => nested(inner),
      };
      await work(inner);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
});

checkpointStoreContract({
  name: 'PostgresCheckpointStore',
  open: async () => {
    const database = await new Postgres({
      environment: process.env,
    }).database();
    return {
      store: await PostgresCheckpointStore.open({
        session: session(database.pool()),
      }),
      [Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
    };
  },
});

checkpointStoreWriteContract({
  name: 'PostgresCheckpointStore',
  open: async () => {
    const database = await new Postgres({
      environment: process.env,
    }).database();
    const pool = database.pool();
    await pool.query(
      'CREATE TABLE output (id serial PRIMARY KEY, row text NOT NULL)',
    );
    const ran: string[] = [];
    const insert = async (transaction: PostgresSession, row: string) => {
      ran.push(row);
      await transaction.query('INSERT INTO output (row) VALUES ($1)', [row]);
    };
    return {
      store: await PostgresCheckpointStore.open({ session: session(pool) }),
      write: (row) => (transaction) => insert(transaction, row),
      failingWrite: (row, error) => async (transaction) => {
        await insert(transaction, row);
        throw error;
      },
      outputs: async () =>
        (await pool.query('SELECT row FROM output ORDER BY id')).rows.map(
          ({ row }: { row: unknown }) => String(row),
        ),
      ran: () => ran,
      [Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
    };
  },
});

const inbox = { stream: 'messages', partition: 'inbox' };

test('eight first opens of one database at once each give a store', async () => {
  await using database = await new Postgres({
    environment: process.env,
  }).database();
  const pool = database.pool();

  const stores = await Promise.all(
    Array.from({ length: 8 }, () =>
      PostgresCheckpointStore.open({ session: session(pool) }),
    ),
  );

  assert.equal(stores.length, 8);
});

test('a stored position that is not JSON makes the claim reject with CorruptCheckpointError', async () => {
  await using database = await new Postgres({
    environment: process.env,
  }).database();
  const pool = database.pool();
  const group = new ConsumerGroup(
    'copy',
    await PostgresCheckpointStore.open({ session: session(pool) }),
  );
  await (await group.claim(inbox, position)).commit(1);
  // No operation of the package writes a broken row: a fault of the disk or a
  // hand edit does. The test writes it as such a fault would.
  await pool.query(
    'UPDATE public.zukhruf_checkpoints SET position = $1 WHERE partition = $2',
    ['{not json', 'inbox'],
  );

  await assert.rejects(group.claim(inbox, position), (error) => {
    assert.ok(error instanceof CorruptCheckpointError);
    assert.deepEqual(error.key, { consumerGroup: 'copy', ...inbox });
    return true;
  });
});
