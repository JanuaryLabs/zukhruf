import assert from 'node:assert/strict';
import { test } from 'node:test';

import type pg from 'pg';

import { Postgres } from '@zukhruf/testing/postgres';

import { PostgresPassageStore, type PostgresSession } from '../postgres.ts';

const server = () =>
  new Postgres({ environment: process.env, image: 'pgvector/pgvector:pg18' });

// The passages of the passage contract as elt writes them, with a metadata
// column of the source row and the tsvector column of the keyword index.
async function contract(
  pool: pg.Pool,
  rows: readonly {
    readonly id: string;
    readonly source: string;
    readonly seq: number;
  }[],
): Promise<void> {
  await pool.query(
    `CREATE TABLE docs_passages (id text PRIMARY KEY, source text NOT NULL, seq integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, text text NOT NULL, product text, keywords tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED)`,
  );
  for (const { id, source, seq } of rows) {
    await pool.query(
      `INSERT INTO docs_passages VALUES ($1, $2, $3, $4, $5, $6, 'vault')`,
      [id, source, seq, seq * 10, seq * 10 + 10, `${source} part ${seq}`],
    );
  }
}

// The session a host writes over node-postgres, as the README shows.
const session = (pool: pg.Pool): PostgresSession => ({
  query: async (sql, parameters) =>
    (await pool.query(sql, [...parameters])).rows,
});

test('get gives each passage it holds by id, with its metadata and without the keyword index, and leaves out an id it does not hold', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'g0', source: 'guide', seq: 0 },
    { id: 'g1', source: 'guide', seq: 1 },
    { id: 'n0', source: 'notes', seq: 0 },
  ]);
  const store = new PostgresPassageStore({
    session: session(pool),
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });

  // Act
  const passages = await store.get(['n0', 'missing', 'g1']);
  const none = await store.get([]);

  // Assert
  assert.deepEqual(
    [...passages].toSorted(([a], [b]) => a.localeCompare(b)),
    [
      [
        'g1',
        {
          id: 'g1',
          text: 'guide part 1',
          source: 'guide',
          seq: 1,
          start: 10,
          end: 20,
          metadata: { product: 'vault' },
        },
      ],
      [
        'n0',
        {
          id: 'n0',
          text: 'notes part 0',
          source: 'notes',
          seq: 0,
          start: 0,
          end: 10,
          metadata: { product: 'vault' },
        },
      ],
    ],
  );
  assert.equal(none.size, 0);
});

test('neighbours gives the passages of the source from seq - windowSize to seq + windowSize, the passage itself among them, in the order of seq', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'g5', source: 'guide', seq: 5 },
    { id: 'g0', source: 'guide', seq: 0 },
    { id: 'g3', source: 'guide', seq: 3 },
    { id: 'g1', source: 'guide', seq: 1 },
    { id: 'g4', source: 'guide', seq: 4 },
    { id: 'g2', source: 'guide', seq: 2 },
    { id: 'n2', source: 'notes', seq: 2 },
  ]);
  const store = new PostgresPassageStore({
    session: session(pool),
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });

  // Act
  const middle = await store.neighbours({
    source: 'guide',
    seq: 2,
    windowSize: 2,
  });
  const edge = await store.neighbours({
    source: 'guide',
    seq: 0,
    windowSize: 1,
  });
  const alone = await store.neighbours({
    source: 'notes',
    seq: 2,
    windowSize: 0,
  });

  // Assert
  assert.deepEqual(
    middle.map(({ id }) => id),
    ['g0', 'g1', 'g2', 'g3', 'g4'],
  );
  assert.deepEqual(
    edge.map(({ id }) => id),
    ['g0', 'g1'],
  );
  assert.deepEqual(
    alone.map(({ id }) => id),
    ['n2'],
  );
  assert.deepEqual(middle[2], {
    id: 'g2',
    text: 'guide part 2',
    source: 'guide',
    seq: 2,
    start: 20,
    end: 30,
    metadata: { product: 'vault' },
  });
});

test('a passages table whose name needs quoting is read by that name', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await pool.query(`
    CREATE TABLE "docs ""passages""" (id text PRIMARY KEY, source text NOT NULL, seq integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, text text NOT NULL);
    INSERT INTO "docs ""passages""" VALUES ('a', 's', 0, 0, 4, 'text');
  `);
  const store = new PostgresPassageStore({
    session: session(pool),
    passages: 'docs "passages"',
    metadata: (columns) => columns,
  });

  // Act
  const byId = await store.get(['a']);
  const window = await store.neighbours({ source: 's', seq: 0, windowSize: 1 });

  // Assert
  assert.deepEqual([...byId.keys()], ['a']);
  assert.deepEqual(
    window.map(({ id }) => id),
    ['a'],
  );
});

test('a store with a schema reads the passages and the neighbours of that schema, and a store without one reads them through the search_path of the session', async () => {
  // Arrange: the same contract in public, which the search_path finds, and
  // in a second schema, each with passages of its own.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'public-g0', source: 'guide', seq: 0 }]);
  await pool.query(`
    CREATE SCHEMA rag;
    CREATE TABLE rag.docs_passages (LIKE public.docs_passages INCLUDING ALL);
    INSERT INTO rag.docs_passages (id, source, seq, start, "end", text, product) VALUES ('rag-g0', 'guide', 0, 0, 10, 'rag part 0', 'boundary');
  `);
  const inSchema = new PostgresPassageStore({
    session: session(pool),
    schema: 'rag',
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const bySearchPath = new PostgresPassageStore({
    session: session(pool),
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });

  // Act
  const fromSchema = await inSchema.get(['rag-g0', 'public-g0']);
  const schemaWindow = await inSchema.neighbours({
    source: 'guide',
    seq: 0,
    windowSize: 1,
  });
  const fromSearchPath = await bySearchPath.get(['rag-g0', 'public-g0']);
  const searchPathWindow = await bySearchPath.neighbours({
    source: 'guide',
    seq: 0,
    windowSize: 1,
  });

  // Assert: the keyword column of the schema's passages is not metadata.
  assert.deepEqual(
    [...fromSchema],
    [
      [
        'rag-g0',
        {
          id: 'rag-g0',
          text: 'rag part 0',
          source: 'guide',
          seq: 0,
          start: 0,
          end: 10,
          metadata: { product: 'boundary' },
        },
      ],
    ],
  );
  assert.deepEqual(
    schemaWindow.map(({ id }) => id),
    ['rag-g0'],
  );
  assert.deepEqual([...fromSearchPath.keys()], ['public-g0']);
  assert.deepEqual(
    searchPathWindow.map(({ id }) => id),
    ['public-g0'],
  );
});
