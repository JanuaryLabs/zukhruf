import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import { FusionRetriever, relativeScoreFusion } from './index.ts';
import { SqliteBM25Retriever, SqliteEmbeddingRetriever } from './sqlite.ts';

type Row = {
  readonly id: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly product?: string;
};

// The passage contract as elt writes it: the passages, an FTS5 keyword index
// with the passages as its external content, and the passage vectors.
function contract(rows: readonly Row[]): DatabaseSync {
  const database = open(':memory:');
  install(database);
  database.exec(`
    CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT) STRICT;
    CREATE VIRTUAL TABLE docs_passages_fts USING fts5(text, content = 'docs_passages');
    CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT;
  `);
  const passage = database.prepare(
    'INSERT INTO docs_passages VALUES (?, ?, 0, 0, ?, ?, ?)',
  );
  const vector = database.prepare(
    `INSERT INTO docs_passage_vectors VALUES (?, ?, 'test/mini (4 dimensions)')`,
  );
  for (const row of rows) {
    passage.run(
      row.id,
      `doc-${row.id}`,
      row.text.length,
      row.text,
      row.product ?? 'a',
    );
    vector.run(row.id, toSql(Vector.from(row.vector)));
  }
  database.exec(
    `INSERT INTO docs_passages_fts (docs_passages_fts) VALUES ('rebuild')`,
  );
  return database;
}

// The keyword search ranks kw before both; the vector search ranks vec,
// both, kw, far, with cosines 1, 0.5, 0 and -1 to the query [1, 0, 0, 0].
const rows: readonly Row[] = [
  { id: 'kw', text: 'rotate key key key', vector: [0, 1, 0, 0] },
  { id: 'both', text: 'rotate the signing key', vector: [1, 1, 1, 1] },
  { id: 'vec', text: 'unrelated words', vector: [1, 0, 0, 0] },
  { id: 'far', text: 'nothing here', vector: [-1, 0, 0, 0] },
];

// A real embedding model cannot run in CI. The AI SDK's own mock model gives
// the vector [1, 0, 0, 0] for the one query of these tests, and records the
// abort signal of each call.
const model = (signals: (AbortSignal | undefined)[]) =>
  new MockEmbeddingModelV4({
    provider: 'test',
    modelId: 'mini',
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values, abortSignal }) => ({
      embeddings: values.map((value) => {
        signals.push(abortSignal);
        if (value !== 'rotate key')
          throw new Error(`The test names no vector for ${value}`);
        return [1, 0, 0, 0];
      }),
      warnings: [],
    }),
  });

const keywords = (database: DatabaseSync) =>
  new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
    index: 'docs_passages_fts',
  });

const retrievers = (
  database: DatabaseSync,
  signals: (AbortSignal | undefined)[] = [],
) => [
  keywords(database),
  new SqliteEmbeddingRetriever({
    database,
    passages: 'docs_passages',
    vectors: 'docs_passage_vectors',
    model: model(signals),
  }),
];

const scores = (
  results: readonly {
    readonly passage: { readonly id: string };
    readonly score: number;
  }[],
) => results.map(({ passage, score }) => [passage.id, score]);

test('a FusionRetriever refuses weights that are not one for each retriever', () => {
  // Arrange
  using database = contract(rows);

  // Act and Assert
  assert.throws(
    () =>
      new FusionRetriever({ retrievers: retrievers(database), weights: [1] }),
    {
      name: 'RangeError',
      message:
        'A FusionRetriever takes one weight for each retriever: got 1 weights for 2 retrievers',
    },
  );
});

test('a rankWindowSize smaller than the topK of the call is refused, as Elasticsearch refuses a rank_window_size smaller than size', async () => {
  // Arrange
  using database = contract(rows);
  const retriever = new FusionRetriever({
    retrievers: retrievers(database),
    rankWindowSize: 2,
  });

  // Act and Assert
  await assert.rejects(retriever.retrieve('rotate key', { topK: 3 }), {
    name: 'RangeError',
    message: 'The rankWindowSize 2 is smaller than the topK 3 of the call',
  });
});

test('by default the lists are fused by reciprocal rank fusion with k 60 and a weight of 1 each', async () => {
  // Arrange
  using database = contract(rows);
  const retriever = new FusionRetriever({ retrievers: retrievers(database) });

  // Act
  const results = await retriever.retrieve('rotate key');

  // Assert: keywords [kw, both], meaning [vec, both, kw, far].
  //   kw   = 1 / 61 + 1 / 63 = 0.032266
  //   both = 1 / 62 + 1 / 62 = 0.032258
  //   vec  = 1 / 61          = 0.016393
  //   far  = 1 / 64          = 0.015625
  assert.deepEqual(scores(results), [
    ['kw', 1 / 61 + 1 / 63],
    ['both', 1 / 62 + 1 / 62],
    ['vec', 1 / 61],
    ['far', 1 / 64],
  ]);
});

test('each retriever gives rankWindowSize passages, the topK of the call when absent, and the call gives the best topK of the fused list', async () => {
  // Arrange
  using database = contract(rows);
  const windowOfTopK = new FusionRetriever({
    retrievers: retrievers(database),
  });
  const windowOfTwo = new FusionRetriever({
    retrievers: retrievers(database),
    rankWindowSize: 2,
  });

  // Act
  const fromTops = await windowOfTopK.retrieve('rotate key', { topK: 1 });
  const fromTwo = await windowOfTwo.retrieve('rotate key', { topK: 1 });

  // Assert: with one passage each, kw and vec tie at 1 / 61 and kw comes
  // first; with two each, both is second in each list: 2 / 62 > 1 / 61.
  assert.deepEqual(scores(fromTops), [['kw', 1 / 61]]);
  assert.deepEqual(scores(fromTwo), [['both', 1 / 62 + 1 / 62]]);
});

test('ten passages come back when the call gives no topK', async () => {
  // Arrange
  using database = contract(
    Array.from({ length: 12 }, (_, index) => ({
      id: `p${String(index).padStart(2, '0')}`,
      text: `rotate key ${'word '.repeat(index)}`,
      vector: [1, index, 0, 0],
    })),
  );
  const retriever = new FusionRetriever({ retrievers: retrievers(database) });

  // Act
  const results = await retriever.retrieve('rotate key');

  // Assert: both lists rank p00 to p11 in the same order.
  assert.deepEqual(
    scores(results),
    Array.from({ length: 10 }, (_, index) => [
      `p${String(index).padStart(2, '0')}`,
      2 / (61 + index),
    ]),
  );
});

test('the filter and includeVectors of the call reach each retriever, and a passage gets the vector that one of the lists gives', async () => {
  // Arrange
  using database = contract(
    rows.map((row) => (row.id === 'both' ? { ...row, product: 'b' } : row)),
  );
  const retriever = new FusionRetriever({ retrievers: retrievers(database) });

  // Act
  const results = await retriever.retrieve('rotate key', {
    filter: { field: 'metadata.product', operator: '==', value: 'a' },
    includeVectors: true,
  });

  // Assert: keywords [kw], meaning [vec, kw, far]; the keyword list gives no
  // vectors, so kw has the one of the meaning list.
  assert.deepEqual(
    results.map(({ passage, score, vector }) => [passage.id, score, vector]),
    [
      ['kw', 1 / 61 + 1 / 62, [0, 1, 0, 0]],
      ['vec', 1 / 61, [1, 0, 0, 0]],
      ['far', 1 / 63, [-1, 0, 0, 0]],
    ],
  );
});

test('the abort signal of the call reaches each retriever', async () => {
  // Arrange
  using database = contract(rows);
  const signals: (AbortSignal | undefined)[] = [];
  const both = new FusionRetriever({
    retrievers: retrievers(database, signals),
  });
  const keywordsOnly = new FusionRetriever({
    retrievers: [keywords(database)],
  });
  const given = new AbortController();
  const aborted = new AbortController();
  aborted.abort();

  // Act
  await both.retrieve('rotate key', { abortSignal: given.signal });

  // Assert: the embedding model of the second retriever got the signal, and
  // the keyword retriever, which calls no model, stops on an aborted one.
  assert.deepEqual(signals, [given.signal]);
  await assert.rejects(
    keywordsOnly.retrieve('rotate key', { abortSignal: aborted.signal }),
    { name: 'AbortError' },
  );
});

test('the fusion and the weights that the caller gives fuse the lists', async () => {
  // Arrange
  using database = contract(rows);
  const retriever = new FusionRetriever({
    retrievers: retrievers(database),
    fusion: relativeScoreFusion(),
    weights: [0.75, 0.25],
  });

  // Act
  const results = await retriever.retrieve('rotate key');

  // Assert: keywords kw 1, both 0 after min-max; meaning 1, 0.5, 0, -1
  // become vec 1, both 0.75, kw 0.5, far 0.
  //   kw   = 0.75 * 1 + 0.25 * 0.5  = 0.875
  //   vec  =            0.25 * 1    = 0.25
  //   both = 0.75 * 0 + 0.25 * 0.75 = 0.1875
  //   far  =            0.25 * 0    = 0
  assert.deepEqual(scores(results), [
    ['kw', 0.875],
    ['vec', 0.25],
    ['both', 0.1875],
    ['far', 0],
  ]);
});
