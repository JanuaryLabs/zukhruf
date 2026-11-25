import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockLanguageModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import {
  FusionRetriever,
  MultiQueryRetriever,
  relativeScoreFusion,
} from './index.ts';
import {
  SqliteBM25Retriever,
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from './sqlite.ts';
import { embeddingModel } from './testing/embedding-model.ts';
import { writeKeywordContract } from './testing/keyword-contract.ts';
import {
  type EntrezQueryBundle,
  RecordingRetriever,
} from './testing/recording-retriever.ts';

type Row = {
  readonly id: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly product?: string;
};

// The passage contract as elt writes it: the passages, an FTS5 keyword index
// with a keywords table as its external content, as ADR 0004 has it, and
// the passage vectors.
function contract(rows: readonly Row[]): DatabaseSync {
  const database = open(':memory:');
  install(database);
  writeKeywordContract(
    database,
    rows.map(({ id, text, product }) => ({
      id,
      text,
      product: product ?? 'a',
    })),
  );
  database.exec(
    'CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT',
  );
  const vector = database.prepare(
    `INSERT INTO docs_passage_vectors VALUES (?, ?, 'test/mini (4 dimensions)')`,
  );
  for (const row of rows) vector.run(row.id, toSql(Vector.from(row.vector)));
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

// The one query of these tests has the vector [1, 0, 0, 0].
const model = (signals: (AbortSignal | undefined)[]) =>
  embeddingModel({ 'rotate key': [1, 0, 0, 0] }, { signals });

const keywords = (database: DatabaseSync) =>
  new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

const retrievers = (
  database: DatabaseSync,
  signals: (AbortSignal | undefined)[] = [],
) => [
  keywords(database),
  new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: model(signals),
  }),
];

const scores = (
  results: readonly {
    readonly passage: { readonly id: string };
    readonly score?: number;
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
  const results = (await retriever.retrieve('rotate key')).passages;

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
  const fromTops = (await windowOfTopK.retrieve('rotate key', { topK: 1 }))
    .passages;
  const fromTwo = (await windowOfTwo.retrieve('rotate key', { topK: 1 }))
    .passages;

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
  const results = (await retriever.retrieve('rotate key')).passages;

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
  const results = (
    await retriever.retrieve('rotate key', {
      filter: { field: 'metadata.product', operator: '==', value: 'a' },
      includeVectors: true,
    })
  ).passages;

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
  const results = (await retriever.retrieve('rotate key')).passages;

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

test('each retriever gets the query bundle unchanged and reads its own text: the keyword search its keywords, the embedding search its query or its customEmbeddings, and a host source its own field', async () => {
  // Arrange: no passage has the words "how" or "do" of the question, so a
  // keyword search of its words finds nothing.
  using database = contract(rows);
  const embeddings = embeddingModel({
    'how do I rotate the key?': [1, 0, 0, 0],
    'A key is rotated with a new one.': [0, 1, 0, 0],
  });
  const source = new RecordingRetriever<EntrezQueryBundle>(['pmid-1']);
  const federation = new FusionRetriever({
    retrievers: [
      source,
      keywords(database),
      new SqliteEmbeddingRetriever({
        store: new SqlitePassageStore({
          database,
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        vectors: 'docs_passage_vectors',
        model: embeddings,
      }),
    ],
  });
  const question = {
    query: 'how do I rotate the key?',
    entrez: 'rotate AND key[Title]',
  };
  const withKeywords: EntrezQueryBundle = {
    ...question,
    keywords: ['rotate', 'key'],
  };
  const withEmbeddings: EntrezQueryBundle = {
    ...withKeywords,
    customEmbeddings: ['A key is rotated with a new one.'],
  };

  // Act
  const byKeywords = (await federation.retrieve(withKeywords)).passages;
  const byQuery = (await federation.retrieve(question)).passages;
  const byEmbeddings = (await federation.retrieve(withEmbeddings)).passages;

  // Assert
  assert.deepEqual(source.queries, [withKeywords, question, withEmbeddings]);
  assert.deepEqual(
    embeddings.doEmbedCalls.map(({ values }) => values),
    [
      ['how do I rotate the key?'],
      ['how do I rotate the key?'],
      ['A key is rotated with a new one.'],
    ],
  );
  // keywords [kw, both]; meaning of the query [vec, both, kw, far]; the
  // source [pmid-1].
  assert.deepEqual(scores(byKeywords), [
    ['kw', 1 / 61 + 1 / 63],
    ['both', 1 / 62 + 1 / 62],
    ['pmid-1', 1 / 61],
    ['vec', 1 / 61],
    ['far', 1 / 64],
  ]);
  // keywords of the words of the question []; the rest as above.
  assert.deepEqual(scores(byQuery), [
    ['pmid-1', 1 / 61],
    ['vec', 1 / 61],
    ['both', 1 / 62],
    ['kw', 1 / 63],
    ['far', 1 / 64],
  ]);
  // meaning of the custom embedding [0, 1, 0, 0]: [kw, both, far, vec].
  assert.deepEqual(scores(byEmbeddings), [
    ['kw', 1 / 61 + 1 / 61],
    ['both', 1 / 62 + 1 / 62],
    ['pmid-1', 1 / 61],
    ['far', 1 / 63],
    ['vec', 1 / 64],
  ]);
});

test('a fusion of plain retrievers takes a string as a query bundle with only query, and a fusion with a retriever that needs its own field takes neither, nor goes under MultiQueryRetriever', async () => {
  // Arrange
  using database = contract(rows);
  const plain = new FusionRetriever({ retrievers: retrievers(database) });
  const federation = new FusionRetriever({
    retrievers: [
      new RecordingRetriever<EntrezQueryBundle>([]),
      keywords(database),
    ],
  });

  // Act
  const byString = (await plain.retrieve('rotate key')).passages;
  const byBundle = (await plain.retrieve({ query: 'rotate key' })).passages;

  // Assert
  assert.deepEqual(byString, byBundle);
  // Each line after a directive is a compile error, which the typecheck
  // target proves; the function never runs.
  const refused = () => [
    // @ts-expect-error: the source needs entrez, and a string has none
    federation.retrieve('rotate key'),
    // @ts-expect-error: the source needs entrez
    federation.retrieve({ query: 'rotate key', keywords: ['rotate'] }),
    // @ts-expect-error: keywords is a list of one or more words
    plain.retrieve({ query: 'rotate key', keywords: [] }),
    new MultiQueryRetriever({
      // @ts-expect-error: a version carries only query, so entrez is missing
      retriever: federation,
      model: new MockLanguageModelV4(),
    }),
  ];
  assert.equal(typeof refused, 'function');
});
