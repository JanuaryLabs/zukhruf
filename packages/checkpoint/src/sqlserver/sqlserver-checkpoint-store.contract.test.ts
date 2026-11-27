import assert from 'node:assert/strict';
import { test } from 'node:test';

import mssql from 'mssql';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import { ConsumerGroup, CorruptCheckpointError } from '../index.ts';
import {
  SqlServerCheckpointStore,
  type SqlServerSession,
} from '../sqlserver.ts';
import { checkpointStoreWriteContract } from '../testing/contract/checkpoint-store-write.ts';
import { checkpointStoreContract } from '../testing/contract/checkpoint-store.ts';
import { position, text } from '../testing/formats.ts';

// The session a host writes over mssql: queries on the pool, and a
// transaction of mssql.Transaction.
const session = (pool: mssql.ConnectionPool): SqlServerSession => ({
  query: async (sql, parameters) => {
    const request = pool.request();
    for (const [name, value] of Object.entries(parameters))
      request.input(name, value);
    return (await request.query(sql)).recordset ?? [];
  },
  transaction: async (work) => {
    const transaction = new mssql.Transaction(pool);
    await transaction.begin();
    try {
      const inner: SqlServerSession = {
        query: async (sql, parameters) => {
          const request = new mssql.Request(transaction);
          for (const [name, value] of Object.entries(parameters))
            request.input(name, value);
          return (await request.query(sql)).recordset ?? [];
        },
        transaction: async (nested) => nested(inner),
      };
      await work(inner);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
});

async function connected() {
  const database = await new SqlServer({ environment: process.env }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  return {
    pool,
    [Symbol.asyncDispose]: async () => {
      await pool.close();
      await database[Symbol.asyncDispose]();
    },
  };
}

checkpointStoreContract({
  name: 'SqlServerCheckpointStore',
  open: async () => {
    const database = await connected();
    return {
      store: await SqlServerCheckpointStore.open({
        session: session(database.pool),
      }),
      [Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
    };
  },
});

checkpointStoreWriteContract({
  name: 'SqlServerCheckpointStore',
  open: async () => {
    const database = await connected();
    await database.pool
      .request()
      .query(
        'CREATE TABLE dbo.output (id int IDENTITY PRIMARY KEY, row nvarchar(200) NOT NULL)',
      );
    const ran: string[] = [];
    const insert = async (transaction: SqlServerSession, row: string) => {
      ran.push(row);
      await transaction.query('INSERT INTO dbo.output (row) VALUES (@row)', {
        row,
      });
    };
    return {
      store: await SqlServerCheckpointStore.open({
        session: session(database.pool),
      }),
      write: (row) => (transaction) => insert(transaction, row),
      failingWrite: (row, error) => async (transaction) => {
        await insert(transaction, row);
        throw error;
      },
      outputs: async () =>
        (
          await database.pool
            .request()
            .query<{ row: string }>('SELECT row FROM dbo.output ORDER BY id')
        ).recordset.map(({ row }) => String(row)),
      ran: () => ran,
      [Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
    };
  },
});

const inbox = { stream: 'messages', partition: 'inbox' };

test('eight first opens of one database at once each give a store', async () => {
  await using database = await connected();
  const schemas = Array.from({ length: 16 }, (_, round) => `round${round}`);
  for (const schema of schemas)
    await database.pool.request().query(`CREATE SCHEMA ${schema}`);

  // The first round opens the connections of the pool one after another; the
  // opens of the later rounds reach the database together, and a race of
  // their first opens shows in one round or another.
  let stores: SqlServerCheckpointStore[] = [];
  for (const schema of schemas)
    stores = await Promise.all(
      Array.from({ length: 8 }, () =>
        SqlServerCheckpointStore.open({
          session: session(database.pool),
          schema,
        }),
      ),
    );
  await Promise.all(
    stores.map(async (store, index) => {
      const context = await new ConsumerGroup('copy', store).claim(
        { ...inbox, partition: `inbox-${index}` },
        position,
      );
      context.state('seen', text).set('row', `inbox-${index}`);
      await context.commit(1);
    }),
  );
  const seen: number[] = [];
  for (const store of stores)
    seen.push(
      (await Array.fromAsync(new ConsumerGroup('copy', store).list())).length,
    );

  assert.deepEqual(
    seen,
    Array.from({ length: 8 }, () => 8),
  );
});

test('a stored position that is not JSON makes the claim reject with CorruptCheckpointError', async () => {
  await using database = await connected();
  const group = new ConsumerGroup(
    'copy',
    await SqlServerCheckpointStore.open({ session: session(database.pool) }),
  );
  await (await group.claim(inbox, position)).commit(1);
  // No operation of the package writes a broken row: a fault of the disk or a
  // hand edit does. The test writes it as such a fault would.
  await database.pool
    .request()
    .input('position', '{not json')
    .query('UPDATE dbo.zukhruf_checkpoints SET position = @position');

  await assert.rejects(group.claim(inbox, position), (error) => {
    assert.ok(error instanceof CorruptCheckpointError);
    assert.deepEqual(error.key, { consumerGroup: 'copy', ...inbox });
    return true;
  });
});
