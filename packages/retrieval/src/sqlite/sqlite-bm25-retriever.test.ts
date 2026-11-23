import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';

import { SqliteBM25Retriever } from '../sqlite.ts';

type Row = {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  readonly product?: string;
};

// The passages and the keyword index as elt writes them: an FTS5 table with
// the passages as its external content, rebuilt from them.
function contract(rows: readonly Row[]): DatabaseSync {
  const database = open(':memory:');
  database.exec(`
    CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT) STRICT;
    CREATE VIRTUAL TABLE docs_passages_fts USING fts5(text, content = 'docs_passages');
  `);
  const insert = database.prepare(
    'INSERT INTO docs_passages VALUES (?, ?, 0, 0, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.source ?? `doc-${row.id}`,
      row.text.length,
      row.text,
      row.product ?? null,
    );
  }
  database.exec(
    `INSERT INTO docs_passages_fts (docs_passages_fts) VALUES ('rebuild')`,
  );
  return database;
}

// The value of FTS5's own ranking function, which the score negates.
const engineBm25 = (database: DatabaseSync, match: string) =>
  database
    .prepare(
      `SELECT p.id, bm25(docs_passages_fts) AS bm25 FROM docs_passages_fts JOIN docs_passages p ON p.rowid = docs_passages_fts.rowid WHERE docs_passages_fts MATCH ?`,
    )
    .all(match)
    .map(({ id, bm25 }) => [id, -Number(bm25)]);

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test('the passages come best first with -bm25() as the score, so a better match has a higher score, and a tie goes to the smaller id', async () => {
  // Arrange
  using database = contract([
    { id: 'c', text: 'signing certificates expire' },
    { id: 'k2', text: 'rotate the signing key' },
    { id: 'b', text: 'rotate key key key' },
    { id: 'k1', text: 'rotate the signing key' },
    { id: 'd', text: 'nothing here at all' },
  ]);
  const retriever = new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  });

  // Act
  const results = await retriever.retrieve('rotate key');

  // Assert
  assert.deepEqual(ids(results), ['b', 'k1', 'k2']);
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    engineBm25(database, 'rotate key').toSorted(
      ([a, x], [b, y]) =>
        Number(y) - Number(x) || String(a).localeCompare(String(b)),
    ),
  );
  assert.ok(results.every(({ score }) => score > 0));
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
  assert.deepEqual(results[1]?.passage, {
    id: 'k1',
    text: 'rotate the signing key',
    source: 'doc-k1',
    seq: 0,
    start: 0,
    end: 22,
    metadata: { product: null },
  });
});

test('passages that are a view with an integer rowid column are searched through that rowid, and the rowid is not metadata', async () => {
  // Arrange: the view's rowid is the key of the parts, in another order than their ids.
  using database = open(':memory:');
  database.exec(`
    CREATE TABLE docs_parts (n INTEGER PRIMARY KEY, id TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT) STRICT;
    CREATE VIEW docs_passages AS SELECT n AS rowid, id, source, seq, start, "end", text, product FROM docs_parts;
    CREATE VIRTUAL TABLE docs_passages_fts USING fts5(text, content = 'docs_passages');
    INSERT INTO docs_parts VALUES (70, 'a', 'doc-a', 0, 0, 13, 'compile C code', 'gcc'), (30, 'b', 'doc-b', 0, 0, 21, 'fix a broken git repo', 'git');
    INSERT INTO docs_passages_fts (docs_passages_fts) VALUES ('rebuild');
  `);
  const retriever = new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  });

  // Act
  const git = await retriever.retrieve('git');
  const compile = await retriever.retrieve('compile');

  // Assert
  assert.deepEqual(
    git.map(({ passage }) => passage),
    [
      {
        id: 'b',
        text: 'fix a broken git repo',
        source: 'doc-b',
        seq: 0,
        start: 0,
        end: 21,
        metadata: { product: 'git' },
      },
    ],
  );
  assert.deepEqual(ids(compile), ['a']);
});

test('the words of the query join with AND by default, and with OR when the operator is OR', async () => {
  // Arrange
  using database = contract([
    { id: 'both', text: 'rotate the signing key' },
    { id: 'rotate', text: 'rotate logs daily' },
    { id: 'signing', text: 'signing certificates' },
    { id: 'neither', text: 'nothing here' },
  ]);
  const options = {
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  };

  // Act
  const and = await new SqliteBM25Retriever(options).retrieve('rotate signing');
  const explicitAnd = await new SqliteBM25Retriever({
    ...options,
    operator: 'AND',
  }).retrieve('rotate signing');
  const or = await new SqliteBM25Retriever({
    ...options,
    operator: 'OR',
  }).retrieve('rotate signing');

  // Assert
  assert.deepEqual(ids(and), ['both']);
  assert.deepEqual(ids(explicitAnd), ['both']);
  assert.deepEqual(ids(or).toSorted(), ['both', 'rotate', 'signing']);
  assert.equal(ids(or)[0], 'both');
});

test('each word of the query is a phrase, so FTS5 syntax in it matches as text and never runs as an operator', async () => {
  // Arrange
  using database = contract([
    { id: 'hyphen', text: 'the key-rotation runbook' },
    { id: 'column', text: 'text: see the title' },
    { id: 'quote', text: 'she said hi' },
    { id: 'near', text: 'stay near key points' },
    { id: 'or', text: 'this or that' },
  ]);
  const retriever = new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  });

  // Act
  const results = {
    // Unquoted, `-` opens a column filter: "no such column: rotation".
    hyphen: ids(await retriever.retrieve('key-rotation')),
    // Unquoted, `text:` filters the column text.
    column: ids(await retriever.retrieve('text: title')),
    // A `"` in a word is doubled, so it cannot end the phrase.
    quote: ids(await retriever.retrieve('said "hi"')),
    near: ids(await retriever.retrieve('NEAR(key points)')),
    // Unquoted, OR would join "this" and "nothing" and match.
    or: ids(await retriever.retrieve('this OR nothing')),
    orAlone: ids(await retriever.retrieve('or')),
    star: ids(await retriever.retrieve('*')),
    // Not doubled, the quotes would close the phrase and run OR: "nothing"OR"key".
    closingQuote: ids(await retriever.retrieve('nothing"OR"key')),
  };

  // Assert
  assert.deepEqual(results, {
    hyphen: ['hyphen'],
    column: ['column'],
    quote: ['quote'],
    near: ['near'],
    or: [],
    orAlone: ['or'],
    star: [],
    closingQuote: [],
  });
});

test('a query of no words gives no passages', async () => {
  // Arrange
  using database = contract([{ id: 'a', text: 'rotate the key' }]);
  const retriever = new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  });

  // Act
  const results = await retriever.retrieve(' \t\n ');

  // Assert
  assert.deepEqual(results, []);
});

test('a keyword search gives 10 passages when the call gives no topK, topK when it gives one, and only the passages its filter selects', async () => {
  // Arrange
  using database = contract(
    Array.from({ length: 12 }, (_, i) => ({
      id: `p${String(i).padStart(2, '0')}`,
      text: 'rotate the key',
      product: i % 2 === 0 ? 'vault' : 'consul',
    })),
  );
  const retriever = new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  });

  // Act
  const byDefault = await retriever.retrieve('key');
  const two = await retriever.retrieve('key', { topK: 2 });
  const filtered = await retriever.retrieve('key', {
    filter: {
      operator: 'AND',
      conditions: [
        { field: 'metadata.product', operator: '==', value: 'consul' },
        { field: 'source', operator: 'not in', value: ['doc-p01'] },
      ],
    },
  });

  // Assert
  assert.deepEqual(
    ids(byDefault),
    Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, '0')}`),
  );
  assert.deepEqual(ids(two), ['p00', 'p01']);
  assert.deepEqual(ids(filtered), ['p03', 'p05', 'p07', 'p09', 'p11']);
});

test('an aborted keyword search rejects with the reason of its signal', async () => {
  // Arrange
  using database = contract([{ id: 'a', text: 'rotate the key' }]);
  const retriever = new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  });
  const reason = new Error('cancelled');

  // Act
  const result = retriever.retrieve('key', {
    abortSignal: AbortSignal.abort(reason),
  });

  // Assert
  await assert.rejects(result, (error) => error === reason);
});

test('a passages table and an index whose names need quoting are searched by those names', async () => {
  // Arrange
  using database = open(':memory:');
  database.exec(`
    CREATE TABLE "docs ""passages""" (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
    CREATE VIRTUAL TABLE "docs ""fts""" USING fts5(text, content = 'docs "passages"');
    INSERT INTO "docs ""passages""" VALUES ('a', 's', 0, 0, 14, 'rotate the key');
    INSERT INTO "docs ""fts""" ("docs ""fts""") VALUES ('rebuild');
  `);
  const retriever = new SqliteBM25Retriever({
    database,
    passages: 'docs "passages"',
    index: 'docs "fts"',
  });

  // Act
  const results = await retriever.retrieve('key');

  // Assert
  assert.deepEqual(ids(results), ['a']);
});
