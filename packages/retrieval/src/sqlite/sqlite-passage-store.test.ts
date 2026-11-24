import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';

import { SqlitePassageStore } from '../sqlite.ts';

// The passages of the passage contract as elt writes them, with a metadata
// column of the source row.
function contract(
  rows: readonly {
    readonly id: string;
    readonly source: string;
    readonly seq: number;
  }[],
): DatabaseSync {
  const database = open(':memory:');
  database.exec(
    'CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT) STRICT',
  );
  const insert = database.prepare(
    `INSERT INTO docs_passages VALUES (?, ?, ?, ?, ?, ?, 'vault')`,
  );
  for (const { id, source, seq } of rows) {
    insert.run(
      id,
      source,
      seq,
      seq * 10,
      seq * 10 + 10,
      `${source} part ${seq}`,
    );
  }
  return database;
}

test('get gives each passage it holds by id, with its metadata, and leaves out an id it does not hold', async () => {
  // Arrange
  using database = contract([
    { id: 'g0', source: 'guide', seq: 0 },
    { id: 'g1', source: 'guide', seq: 1 },
    { id: 'n0', source: 'notes', seq: 0 },
  ]);
  const store = new SqlitePassageStore({ database, passages: 'docs_passages' });

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
  using database = contract([
    { id: 'g5', source: 'guide', seq: 5 },
    { id: 'g0', source: 'guide', seq: 0 },
    { id: 'g3', source: 'guide', seq: 3 },
    { id: 'g1', source: 'guide', seq: 1 },
    { id: 'g4', source: 'guide', seq: 4 },
    { id: 'g2', source: 'guide', seq: 2 },
    { id: 'n2', source: 'notes', seq: 2 },
  ]);
  const store = new SqlitePassageStore({ database, passages: 'docs_passages' });

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
  using database = open(':memory:');
  database.exec(`
    CREATE TABLE "docs ""passages""" (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
    INSERT INTO "docs ""passages""" VALUES ('a', 's', 0, 0, 4, 'text');
  `);
  const store = new SqlitePassageStore({
    database,
    passages: 'docs "passages"',
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

test('a SQLite store takes no schema, so no schema can name relations that the store would not read', async () => {
  // Arrange
  using database = contract([{ id: 'g0', source: 'guide', seq: 0 }]);

  // Act
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    // @ts-expect-error SQLite has no schema: the store holds the database and the passages only
    schema: 'rag',
  });
  const passages = await store.get(['g0']);

  // Assert
  assert.deepEqual([...passages.keys()], ['g0']);
});
