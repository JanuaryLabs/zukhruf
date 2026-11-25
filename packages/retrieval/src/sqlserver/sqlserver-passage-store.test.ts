import assert from 'node:assert/strict';
import { test } from 'node:test';

import type mssql from 'mssql';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import { SqlServerPassageStore, type SqlServerSession } from '../sqlserver.ts';

const server = () =>
  new SqlServer({
    environment: process.env,
    image: 'mcr.microsoft.com/mssql/server:2025-latest',
    fullTextSearch: true,
  });

// SQL Server 2025 crashes at start about once in 41 starts when an arm64
// engine emulates amd64 (#5469), so a test that runs it runs only where the
// engine runs amd64 natively, as on CI.
const emulation = await SqlServer.emulation({ environment: process.env });

// The passages of the passage contract as elt writes them, with a metadata
// column of the source row. The id compares in binary, as the full-text key
// of the keyword index needs; every other text column keeps the
// case-insensitive collation of the server.
async function contract(
  pool: mssql.ConnectionPool,
  rows: readonly {
    readonly id: string;
    readonly source: string;
    readonly seq: number;
  }[],
  schema = 'dbo',
): Promise<void> {
  await pool
    .request()
    .batch(
      `CREATE TABLE [${schema}].docs_passages (id NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY, source NVARCHAR(400) NOT NULL, seq INT NOT NULL, start INT NOT NULL, [end] INT NOT NULL, text NVARCHAR(MAX) NOT NULL, product NVARCHAR(100))`,
    );
  for (const { id, source, seq } of rows) {
    await pool
      .request()
      .input('id', id)
      .input('source', source)
      .input('seq', seq)
      .input('start', seq * 10)
      .input('end', seq * 10 + 10)
      .input('text', `${source} part ${seq}`)
      .query(
        `INSERT INTO [${schema}].docs_passages VALUES (@id, @source, @seq, @start, @end, @text, N'vault')`,
      );
  }
}

// The session a host writes over mssql, as the README shows.
const session = (pool: mssql.ConnectionPool): SqlServerSession => ({
  query: async (sql, parameters) => {
    const request = pool.request();
    for (const [name, value] of Object.entries(parameters))
      request.input(name, value);
    return (await request.query(sql)).recordset ?? [];
  },
});

test(
  'get gives each passage it holds by id, with its metadata, and leaves out an id it does not hold or holds in another case',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'g0', source: 'guide', seq: 0 },
      { id: 'g1', source: 'guide', seq: 1 },
      { id: 'n0', source: 'notes', seq: 0 },
    ]);
    const store = new SqlServerPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });

    // Act
    const passages = await store.get(['n0', 'missing', 'g1', 'G0']);
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
  },
);

test(
  'neighbours gives the passages of the source from seq - windowSize to seq + windowSize, the passage itself among them, in the order of seq',
  { skip: emulation },
  async () => {
    // Arrange: `Guide` is another source than `guide`, though the
    // case-insensitive collation of the server would call them equal.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'g5', source: 'guide', seq: 5 },
      { id: 'g0', source: 'guide', seq: 0 },
      { id: 'g3', source: 'guide', seq: 3 },
      { id: 'g1', source: 'guide', seq: 1 },
      { id: 'G2', source: 'Guide', seq: 2 },
      { id: 'g4', source: 'guide', seq: 4 },
      { id: 'g2', source: 'guide', seq: 2 },
      { id: 'n2', source: 'notes', seq: 2 },
    ]);
    const store = new SqlServerPassageStore({
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
  },
);

test(
  'when the id of the passages is case-insensitive, get tells apart ids that differ only in case, and neighbours of one seq come in the binary order of their ids',
  { skip: emulation },
  async () => {
    // Arrange: the id keeps the case-insensitive collation of the server, so it
    // has no key: a key in that collation refuses `a` beside `A` (error 2627).
    // `B` sorts after `a` in that collation.
    await using database = await server().database();
    const pool = await database.pool();
    await pool.request().batch(`
    CREATE TABLE docs_passages (id NVARCHAR(450) NOT NULL, source NVARCHAR(400) NOT NULL, seq INT NOT NULL, start INT NOT NULL, [end] INT NOT NULL, text NVARCHAR(MAX) NOT NULL);
    INSERT INTO docs_passages VALUES (N'a', N'guide', 1, 10, 20, N'small a'), (N'A', N'notes', 0, 0, 10, N'capital A'), (N'B', N'guide', 1, 10, 20, N'capital B'), (N'g0', N'guide', 0, 0, 10, N'first');
  `);
    const store = new SqlServerPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });

    // Act
    const byId = await store.get(['a']);
    const window = await store.neighbours({
      source: 'guide',
      seq: 0,
      windowSize: 1,
    });

    // Assert
    assert.deepEqual(
      [...byId].map(([id, { text }]) => [id, text]),
      [['a', 'small a']],
    );
    assert.deepEqual(
      window.map(({ id }) => id),
      ['g0', 'B', 'a'],
    );
  },
);

test(
  'a passages table whose name needs quoting is read by that name',
  { skip: emulation },
  async () => {
    // Arrange: the name `docs ]passages]` has the closing bracket of a T-SQL identifier.
    await using database = await server().database();
    const pool = await database.pool();
    await pool.request().batch(`
    CREATE TABLE [docs ]]passages]]] (id NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY, source NVARCHAR(400) NOT NULL, seq INT NOT NULL, start INT NOT NULL, [end] INT NOT NULL, text NVARCHAR(MAX) NOT NULL);
    INSERT INTO [docs ]]passages]]] VALUES (N'a', N's', 0, 0, 4, N'text');
  `);
    const store = new SqlServerPassageStore({
      session: session(pool),
      passages: 'docs ]passages]',
      metadata: (columns) => columns,
    });

    // Act
    const byId = await store.get(['a']);
    const window = await store.neighbours({
      source: 's',
      seq: 0,
      windowSize: 1,
    });

    // Assert
    assert.deepEqual([...byId.keys()], ['a']);
    assert.deepEqual(
      window.map(({ id }) => id),
      ['a'],
    );
  },
);

test(
  'a store with a schema reads the passages and the neighbours of that schema, and a store without one reads them through the default schema of the user',
  { skip: emulation },
  async () => {
    // Arrange: the same contract in dbo, the default schema of the user, and
    // in a second schema, each with passages of its own.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [{ id: 'dbo-g0', source: 'guide', seq: 0 }]);
    // CREATE SCHEMA is the only statement of its batch.
    await pool.request().batch('CREATE SCHEMA rag');
    await contract(pool, [{ id: 'rag-g0', source: 'guide', seq: 0 }], 'rag');
    const inSchema = new SqlServerPassageStore({
      session: session(pool),
      schema: 'rag',
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });
    const byDefaultSchema = new SqlServerPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });

    // Act
    const fromSchema = await inSchema.get(['rag-g0', 'dbo-g0']);
    const schemaWindow = await inSchema.neighbours({
      source: 'guide',
      seq: 0,
      windowSize: 1,
    });
    const fromDefault = await byDefaultSchema.get(['rag-g0', 'dbo-g0']);
    const defaultWindow = await byDefaultSchema.neighbours({
      source: 'guide',
      seq: 0,
      windowSize: 1,
    });

    // Assert
    assert.deepEqual(
      [...fromSchema],
      [
        [
          'rag-g0',
          {
            id: 'rag-g0',
            text: 'guide part 0',
            source: 'guide',
            seq: 0,
            start: 0,
            end: 10,
            metadata: { product: 'vault' },
          },
        ],
      ],
    );
    assert.deepEqual(
      schemaWindow.map(({ id }) => id),
      ['rag-g0'],
    );
    assert.deepEqual([...fromDefault.keys()], ['dbo-g0']);
    assert.deepEqual(
      defaultWindow.map(({ id }) => id),
      ['dbo-g0'],
    );
  },
);

test(
  "get and neighbours pass the call's signal to the session",
  { skip: emulation },
  async () => {
    // Arrange: the session records the signal of each query.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [{ id: 'g0', source: 'guide', seq: 0 }]);
    const signals: (AbortSignal | undefined)[] = [];
    const host = session(pool);
    const store = new SqlServerPassageStore({
      session: {
        query: (sql, parameters, options) => {
          signals.push(options?.signal);
          return host.query(sql, parameters);
        },
      },
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });
    const controller = new AbortController();
    const { signal } = controller;

    // Act
    await store.get(['g0'], { signal });
    await store.neighbours({ source: 'guide', seq: 0, windowSize: 1, signal });

    // Assert
    assert.deepEqual(signals, [signal, signal]);
  },
);
