import assert from 'node:assert/strict';
import { type DatabaseSync, constants } from 'node:sqlite';

import { wrapEmbeddingModel } from 'ai';
import { MockEmbeddingModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { test } from '@zukhruf/testing/node';
import { DimensionMismatchError, Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import { type Metadata, ModelMismatchError, type QueryType } from '../index.ts';
import { SqliteEmbeddingRetriever, SqlitePassageStore } from '../sqlite.ts';
import { embeddingModel } from '../testing/embedding-model.ts';
import { RecordingMetadata } from '../testing/recording-metadata.ts';

type Row = {
  readonly id: string;
  readonly source?: string;
  readonly seq?: number;
  readonly vector: readonly number[];
  readonly model?: string;
  readonly product?: string | null;
  readonly year?: number | null;
};

// The passage contract as elt's Vectorizer writes it: the passages with the
// metadata columns of their source row, and the passage vectors with the
// model identity of each vector. A vector of the test is not of length 1:
// the cosine does not depend on the length, and its values stay exact in
// float32, so each score is exact.
function contract(rows: readonly Row[]): DatabaseSync {
  const database = open(':memory:');
  install(database);
  database.exec(`
    CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT, year INTEGER) STRICT;
    CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT;
  `);
  const passage = database.prepare(
    'INSERT INTO docs_passages VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const vector = database.prepare(
    'INSERT INTO docs_passage_vectors VALUES (?, ?, ?)',
  );
  for (const row of rows) {
    const seq = row.seq ?? 0;
    passage.run(
      row.id,
      row.source ?? `doc-${row.id}`,
      seq,
      seq * 10,
      seq * 10 + 10,
      `text of ${row.id}`,
      row.product ?? null,
      row.year ?? null,
    );
    vector.run(
      row.id,
      toSql(Vector.from(row.vector)),
      row.model ?? 'test/mini (4 dimensions)',
    );
  }
  return database;
}

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test('the passages come best first, each with the cosine similarity as its score, and a tie goes to the smaller id', async () => {
  // Arrange
  using database = contract([
    { id: 'd', vector: [-1, 0, 0, 0] },
    { id: 'c', vector: [0, 1, 0, 0] },
    { id: 'b2', vector: [2, 2, 2, 2] },
    { id: 'b1', vector: [1, 1, 1, 1] },
    { id: 'a', vector: [3, 0, 0, 0] },
    { id: 'e', vector: [-1, 1, 1, 1] },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ 'rotate a key': [1, 0, 0, 0] }),
  });

  // Act
  const results = (await retriever.retrieve('rotate a key')).passages;

  // Assert
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['a', 1],
      ['b1', 0.5],
      ['b2', 0.5],
      ['c', 0],
      ['e', -0.5],
      ['d', -1],
    ],
  );
  assert.deepEqual(results[0], {
    passage: {
      id: 'a',
      text: 'text of a',
      source: 'doc-a',
      seq: 0,
      start: 0,
      end: 10,
      metadata: { product: null, year: null },
    },
    score: 1,
  });
});

test('a call gives 10 passages when it gives no topK, and topK passages when it gives one', async () => {
  // Arrange: passage i is less like the query as i grows.
  using database = contract(
    Array.from({ length: 12 }, (_, i) => ({
      id: `p${String(i).padStart(2, '0')}`,
      vector: [12 - i, i, 0, 0],
    })),
  );
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
  const byDefault = (await retriever.retrieve('q')).passages;
  const three = (await retriever.retrieve('q', { topK: 3 })).passages;

  // Assert
  assert.deepEqual(
    ids(byDefault),
    Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, '0')}`),
  );
  assert.deepEqual(ids(three), ['p00', 'p01', 'p02']);
});

test('a query model of another provider or model id fails with ModelMismatchError before any model call', async () => {
  // Arrange
  using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
  const otherModel = embeddingModel(
    { q: [1, 0, 0, 0] },
    { provider: 'test', modelId: 'large' },
  );
  const otherProvider = embeddingModel(
    { q: [1, 0, 0, 0] },
    { provider: 'other', modelId: 'mini' },
  );
  const retriever = (query: MockEmbeddingModelV4 | string) =>
    new SqliteEmbeddingRetriever({
      store: new SqlitePassageStore({
        database,
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
      vectors: 'docs_passage_vectors',
      model: query,
    });

  // Act
  const byModel = retriever(otherModel).retrieve('q');
  const byProvider = retriever(otherProvider).retrieveMany(['q']);
  // A string model id is `provider/model`, as elt names it; the call fails before the gateway.
  const byString = retriever('test/large').retrieve('q');

  // Assert
  await assert.rejects(byModel, (error) => {
    assert.ok(error instanceof ModelMismatchError);
    assert.deepEqual(error.stored, { provider: 'test', modelId: 'mini' });
    assert.deepEqual(error.query, { provider: 'test', modelId: 'large' });
    assert.equal(
      error.message,
      'The query model test/large is not the model of the stored vectors, test/mini',
    );
    return true;
  });
  await assert.rejects(byProvider, (error) => {
    assert.ok(error instanceof ModelMismatchError);
    assert.deepEqual(error.query, { provider: 'other', modelId: 'mini' });
    return true;
  });
  await assert.rejects(byString, (error) => {
    assert.ok(error instanceof ModelMismatchError);
    assert.deepEqual(error.query, { provider: 'test', modelId: 'large' });
    return true;
  });
  assert.equal(otherModel.doEmbedCalls.length, 0);
  assert.equal(otherProvider.doEmbedCalls.length, 0);
});

test('with two stored identities, ModelMismatchError names the first in the order of its text', async () => {
  // Arrange
  using database = contract([
    { id: 'a', vector: [1, 0, 0, 0], model: 'test/mini (4 dimensions)' },
    { id: 'b', vector: [1, 0], model: 'test/large (2 dimensions)' },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel(
      { q: [1, 0, 0, 0] },
      { provider: 'other', modelId: 'mini' },
    ),
  });

  // Act
  const result = retriever.retrieve('q');

  // Assert
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof ModelMismatchError);
    assert.deepEqual(error.stored, { provider: 'test', modelId: 'large' });
    return true;
  });
});

test('a query vector of other dimensions fails with DimensionMismatchError after the model call', async () => {
  // Arrange
  using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
  const query = embeddingModel({ q: [1, 0] });
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const result = retriever.retrieve('q');

  // Assert
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof DimensionMismatchError);
    assert.equal(error.expected, 4);
    assert.equal(error.actual, 2);
    return true;
  });
  assert.equal(query.doEmbedCalls.length, 1);
});

test('a query compares only with the vectors of its own model identity when the table holds two', async () => {
  // Arrange: elt is in the middle of a refresh to 2 dimensions.
  using database = contract([
    { id: 'old', vector: [1, 0, 0, 0] },
    { id: 'new-far', vector: [0, 1], model: 'test/mini (2 dimensions)' },
    { id: 'new-near', vector: [1, 0], model: 'test/mini (2 dimensions)' },
    { id: 'other', vector: [1, 0], model: 'test/large (2 dimensions)' },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0] }),
  });

  // Act
  const results = (await retriever.retrieve('q')).passages;

  // Assert
  assert.deepEqual(ids(results), ['new-near', 'new-far']);
});

test('a stored model that is not a model identity, and a string model id without a provider, fail the call before any model call', async () => {
  // Arrange
  using database = contract([
    { id: 'a', vector: [1, 0, 0, 0], model: 'text-embedding-3-small' },
  ]);
  const query = embeddingModel({ q: [1, 0, 0, 0] });
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const result = retriever.retrieve('q');

  // Assert
  await assert.rejects(result, {
    name: 'TypeError',
    message:
      'The stored model "text-embedding-3-small" is not a model identity of the form "provider/model (n dimensions)"',
  });
  await assert.rejects(
    new SqliteEmbeddingRetriever({
      store: new SqlitePassageStore({
        database,
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
      vectors: 'docs_passage_vectors',
      model: 'mini',
    }).retrieve('q'),
    {
      name: 'TypeError',
      message: 'The model id "mini" names no provider: write "provider/model"',
    },
  );
  assert.equal(query.doEmbedCalls.length, 0);
});

test('an empty vector table gives no passages and makes no model call', async () => {
  // Arrange
  using database = contract([]);
  const query = embeddingModel({ q: [1, 0, 0, 0] });
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const one = (await retriever.retrieve('q')).passages;
  const many = (await retriever.retrieveMany(['q', 'q'])).map(
    ({ passages }) => passages,
  );

  // Assert
  assert.deepEqual(one, []);
  assert.deepEqual(many, [[], []]);
  assert.equal(query.doEmbedCalls.length, 0);
});

test('includeVectors gives the stored vector of each passage, and no call gives it otherwise', async () => {
  // Arrange
  using database = contract([
    { id: 'a', vector: [3, 0, 0, 0] },
    { id: 'b', vector: [0.5, -0.25, 1, 2] },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
  const withVectors = (await retriever.retrieve('q', { includeVectors: true }))
    .passages;
  const without = (await retriever.retrieve('q')).passages;
  const [many] = (
    await retriever.retrieveMany(['q'], { includeVectors: true })
  ).map(({ passages }) => passages);

  // Assert
  assert.deepEqual(
    withVectors.map(({ vector }) => vector),
    [
      [3, 0, 0, 0],
      [0.5, -0.25, 1, 2],
    ],
  );
  assert.deepEqual(many, withVectors);
  assert.ok(without.every((result) => !('vector' in result)));
});

test('retrieveMany embeds the queries in one model call and gives one list for each query, in the order of the queries', async () => {
  // Arrange
  using database = contract([
    { id: 'x', vector: [1, 0, 0, 0] },
    { id: 'y', vector: [0, 1, 0, 0] },
    { id: 'z', vector: [0, 0, 1, 0] },
  ]);
  const query = embeddingModel({
    'toward y': [0, 2, 1, 0],
    'toward x': [2, 0, 1, 0],
    'toward z': [0, 0, 1, 0],
  });
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const lists = (
    await retriever.retrieveMany(['toward y', 'toward x', 'toward z'], {
      topK: 2,
    })
  ).map(({ passages }) => passages);
  const one = (await retriever.retrieve('toward x', { topK: 2 })).passages;

  // Assert
  assert.deepEqual(lists.map(ids), [
    ['y', 'z'],
    ['x', 'z'],
    ['z', 'x'],
  ]);
  assert.deepEqual(lists[1], one);
  assert.deepEqual(
    query.doEmbedCalls.map(({ values }) => values),
    [['toward y', 'toward x', 'toward z'], ['toward x']],
  );
});

test('the texts of customEmbeddings are embedded in place of query, and two texts search with the mean of their vectors, in retrieve and in each query of retrieveMany', async () => {
  // Arrange
  using database = contract([
    { id: 'x', vector: [1, 0, 0, 0] },
    { id: 'xy', vector: [1, 1, 0, 0] },
    { id: 'y', vector: [0, 1, 0, 0] },
  ]);
  const query = embeddingModel({
    'toward x': [2, 0, 0, 0],
    'toward y': [0, 2, 0, 0],
  });
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act: the model knows no vector for the query of a bundle.
  const both = {
    query: 'how do I rotate a key?',
    customEmbeddings: ['toward x', 'toward y'],
  } as const;
  const one = (await retriever.retrieve(both)).passages;
  const lists = (
    await retriever.retrieveMany([
      both,
      { query: 'how do I rotate a key?', customEmbeddings: ['toward y'] },
      'toward x',
    ])
  ).map(({ passages }) => passages);

  // Assert: the mean [1, 1, 0, 0] is xy itself; x and y tie at 1 / sqrt(2).
  assert.deepEqual(ids(one), ['xy', 'x', 'y']);
  assert.deepEqual(lists.map(ids), [
    ['xy', 'x', 'y'],
    ['y', 'xy', 'x'],
    ['x', 'xy', 'y'],
  ]);
  assert.deepEqual(
    query.doEmbedCalls.map(({ values }) => values),
    [
      ['toward x', 'toward y'],
      ['toward x', 'toward y', 'toward y', 'toward x'],
    ],
  );
});

test('texts of one query whose vectors have different dimensions fail with DimensionMismatchError, whichever text comes first, in retrieve and in retrieveMany', async () => {
  // Arrange: a broken model gives 4 dimensions for one text and 2 for another.
  using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
  const query = embeddingModel({
    four: [1, 0, 0, 0],
    two: [1, 0],
    other: [0, 1, 0, 0],
  });
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });
  const mismatch = (expected: number, actual: number) => (error: unknown) => {
    assert.ok(error instanceof DimensionMismatchError);
    assert.deepEqual([error.expected, error.actual], [expected, actual]);
    return true;
  };

  // Act
  const longFirst = retriever.retrieve({
    query: 'q',
    customEmbeddings: ['four', 'two'],
  });
  const shortFirst = retriever.retrieve({
    query: 'q',
    customEmbeddings: ['two', 'four'],
  });
  const many = retriever.retrieveMany([
    'other',
    { query: 'q', customEmbeddings: ['four', 'two'] },
  ]);

  // Assert
  await assert.rejects(longFirst, mismatch(4, 2));
  await assert.rejects(shortFirst, mismatch(2, 4));
  await assert.rejects(many, mismatch(4, 2));
});

test('retrieveMany of no queries gives no lists', async () => {
  // Arrange
  using database = contract([{ id: 'x', vector: [1, 0, 0, 0] }]);
  const query = embeddingModel({});
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const lists = (await retriever.retrieveMany([])).map(
    ({ passages }) => passages,
  );

  // Assert
  assert.deepEqual(lists, []);
  assert.equal(query.doEmbedCalls.length, 0);
});

test('an aborted call rejects with the reason of its signal, before the model call and after it', async () => {
  // Arrange
  using database = contract([{ id: 'x', vector: [1, 0, 0, 0] }]);
  const before = embeddingModel({ q: [1, 0, 0, 0] });
  const controller = new AbortController();
  // A model that ignores the signal and answers after the abort.
  const during = new MockEmbeddingModelV4({
    provider: 'test',
    modelId: 'mini',
    doEmbed: async () => {
      controller.abort(new Error('the user left'));
      return { embeddings: [[1, 0, 0, 0]], warnings: [] };
    },
  });
  const retriever = (query: MockEmbeddingModelV4) =>
    new SqliteEmbeddingRetriever({
      store: new SqlitePassageStore({
        database,
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
      vectors: 'docs_passage_vectors',
      model: query,
    });
  const reason = new Error('cancelled');

  // Act
  const early = retriever(before).retrieve('q', {
    signal: AbortSignal.abort(reason),
  });
  const late = retriever(during).retrieve('q', {
    signal: controller.signal,
  });

  // Assert
  await assert.rejects(early, (error) => error === reason);
  await assert.rejects(late, (error) => error === controller.signal.reason);
  assert.equal(before.doEmbedCalls.length, 0);
  assert.equal(during.doEmbedCalls[0]?.abortSignal, controller.signal);
});

test('each filter operator selects the passages it names, on passage fields and on metadata columns, with NULL compared as a value', async () => {
  // Arrange
  using database = contract([
    {
      id: 'a',
      source: 'guide',
      seq: 0,
      vector: [1, 0, 0, 0],
      product: 'vault',
      year: 2024,
    },
    {
      id: 'b',
      source: 'guide',
      seq: 1,
      vector: [1, 0, 0, 0],
      product: 'vault',
      year: 2025,
    },
    {
      id: 'c',
      source: 'notes',
      seq: 2,
      vector: [1, 0, 0, 0],
      product: 'boundary',
      year: 2026,
    },
    {
      id: 'd',
      source: 'notes',
      seq: 3,
      vector: [1, 0, 0, 0],
      product: null,
      year: null,
    },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });
  const filtered = async (filter: Parameters<typeof retriever.retrieve>[1]) =>
    ids((await retriever.retrieve('q', filter)).passages).toSorted();

  // Act
  const results = {
    equal: await filtered({
      filter: { field: 'metadata.product', operator: '==', value: 'vault' },
    }),
    equalNull: await filtered({
      filter: { field: 'metadata.product', operator: '==', value: null },
    }),
    notEqual: await filtered({
      filter: { field: 'metadata.product', operator: '!=', value: 'vault' },
    }),
    greater: await filtered({
      filter: { field: 'metadata.year', operator: '>', value: 2025 },
    }),
    greaterOrEqual: await filtered({
      filter: { field: 'metadata.year', operator: '>=', value: 2025 },
    }),
    less: await filtered({ filter: { field: 'seq', operator: '<', value: 1 } }),
    lessOrEqual: await filtered({
      filter: { field: 'seq', operator: '<=', value: 1 },
    }),
    in: await filtered({
      filter: { field: 'source', operator: 'in', value: ['notes', 'other'] },
    }),
    inEmpty: await filtered({
      filter: { field: 'source', operator: 'in', value: [] },
    }),
    notIn: await filtered({
      filter: {
        field: 'metadata.product',
        operator: 'not in',
        value: ['vault'],
      },
    }),
    start: await filtered({
      filter: { field: 'start', operator: '==', value: 20 },
    }),
    end: await filtered({
      filter: { field: 'end', operator: '==', value: 20 },
    }),
  };

  // Assert
  assert.deepEqual(results, {
    equal: ['a', 'b'],
    equalNull: ['d'],
    notEqual: ['c', 'd'],
    greater: ['c'],
    greaterOrEqual: ['b', 'c'],
    less: ['a'],
    lessOrEqual: ['a', 'b'],
    in: ['c', 'd'],
    inEmpty: [],
    notIn: ['c', 'd'],
    start: ['c'],
    end: ['b'],
  });
});

test('AND, OR and NOT nest, NOT negates all its conditions, and a boolean value compares as 1 or 0', async () => {
  // Arrange
  using database = contract([
    { id: 'a', vector: [1, 0, 0, 0], product: 'vault', year: 2024 },
    { id: 'b', vector: [1, 0, 0, 0], product: 'vault', year: 2026 },
    { id: 'c', vector: [1, 0, 0, 0], product: 'boundary', year: 2026 },
    { id: 'd', vector: [1, 0, 0, 0], product: 'consul', year: 1 },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });
  const filtered = async (filter: Parameters<typeof retriever.retrieve>[1]) =>
    ids((await retriever.retrieve('q', filter)).passages).toSorted();

  // Act
  const results = {
    // vault and (2024 or boundary): only a.
    and: await filtered({
      filter: {
        operator: 'AND',
        conditions: [
          { field: 'metadata.product', operator: '==', value: 'vault' },
          {
            operator: 'OR',
            conditions: [
              { field: 'metadata.year', operator: '==', value: 2024 },
              { field: 'metadata.product', operator: '==', value: 'boundary' },
            ],
          },
        ],
      },
    }),
    // not (vault and 2026): every passage but b.
    not: await filtered({
      filter: {
        operator: 'NOT',
        conditions: [
          { field: 'metadata.product', operator: '==', value: 'vault' },
          { field: 'metadata.year', operator: '==', value: 2026 },
        ],
      },
    }),
    or: await filtered({
      filter: {
        operator: 'OR',
        conditions: [
          { field: 'metadata.product', operator: '==', value: 'consul' },
          { field: 'metadata.year', operator: '<', value: 2025 },
        ],
      },
    }),
    true: await filtered({
      filter: { field: 'metadata.year', operator: '==', value: true },
    }),
    emptyAnd: await filtered({ filter: { operator: 'AND', conditions: [] } }),
    emptyOr: await filtered({ filter: { operator: 'OR', conditions: [] } }),
  };

  // Assert
  assert.deepEqual(results, {
    and: ['a'],
    not: ['a', 'c', 'd'],
    or: ['a', 'd'],
    true: ['d'],
    emptyAnd: ['a', 'b', 'c', 'd'],
    emptyOr: [],
  });
});

test('SQL in a filter field stays one column name, and SQL in a filter value stays a value', async () => {
  // Arrange
  using database = contract([
    { id: 'a', vector: [1, 0, 0, 0], product: 'vault' },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
  const byField = retriever.retrieve('q', {
    filter: {
      field: 'metadata.product" IS NOT NULL OR "1',
      operator: '==',
      value: 'none',
    },
  });
  const byValue = (
    await retriever.retrieve('q', {
      filter: {
        field: 'metadata.product',
        operator: '==',
        value: "none' OR 1 = 1 OR product = '",
      },
    })
  ).passages;
  const bySetValue = (
    await retriever.retrieve('q', {
      filter: {
        field: 'metadata.product',
        operator: 'in',
        value: ["x') OR 1 = 1 --"],
      },
    })
  ).passages;

  // Assert
  // The engine looks for one column with the whole field as its name.
  await assert.rejects(byField, {
    message: /^no such column: .*product" IS NOT NULL OR "1$/,
  });
  assert.deepEqual(byValue, []);
  assert.deepEqual(bySetValue, []);
});

test('a filter field that is not a passage field or a metadata column, a value SQL cannot hold and an in filter without a list fail the call', async () => {
  // Arrange
  using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
  // A caller without the types of the package can pass any field and value,
  // where the types refuse it.
  const byField = retriever.retrieve('q', {
    // @ts-expect-error text is not a filter field
    filter: { field: 'text', operator: '==', value: 'x' },
  });
  const byObject = retriever.retrieve('q', {
    // @ts-expect-error a filter value is not an object
    filter: { field: 'source', operator: '==', value: { id: 'x' } },
  });
  const byValue = retriever.retrieve('q', {
    // @ts-expect-error an in filter takes a list
    filter: { field: 'source', operator: 'not in', value: 'doc-a' },
  });

  // Assert
  await assert.rejects(byField, {
    name: 'TypeError',
    message:
      'The filter field "text" is not source, seq, start, end or metadata.<column>',
  });
  await assert.rejects(byObject, {
    name: 'TypeError',
    message:
      'A filter value is a string, a number, a bigint, a boolean, null or a Uint8Array, not [object Object]',
  });
  await assert.rejects(byValue, {
    name: 'TypeError',
    message:
      'The value of an "not in" filter on source is an array, not "doc-a"',
  });
});

test('a metadata column keeps its name and value even when it has the name of a column that the search adds', async () => {
  // Arrange
  using database = open(':memory:');
  install(database);
  database.exec(`
    CREATE TABLE "docs ""passages""" (id TEXT PRIMARY KEY, source TEXT, seq INTEGER, start INTEGER, "end" INTEGER, text TEXT, distance TEXT, vector TEXT, query TEXT) STRICT;
    CREATE TABLE "docs vectors" (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT;
    INSERT INTO "docs ""passages""" VALUES ('a', 's', 0, 0, 4, 'text', 'far', 'none', 'who');
  `);
  database
    .prepare('INSERT INTO "docs vectors" VALUES (?, ?, ?)')
    .run('a', toSql(Vector.from([1, 0])), 'test/mini (2 dimensions)');
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs "passages"',
      metadata: (columns) => columns,
    }),
    vectors: 'docs vectors',
    model: embeddingModel({ q: [1, 0] }),
  });

  // Act
  const [result] = (
    await retriever.retrieve('q', {
      filter: { field: 'metadata.distance', operator: '==', value: 'far' },
    })
  ).passages;

  // Assert
  assert.deepEqual(result?.passage.metadata, {
    distance: 'far',
    vector: 'none',
    query: 'who',
  });
  assert.equal(result?.score, 1);
});

// A host's metadata: the year of the source row, a number, and no other
// column.
const year = ({ year }: Metadata): { readonly year: number } => {
  if (typeof year !== 'number') {
    throw new TypeError(`A passage has a year, not ${String(year)}`);
  }
  return { year };
};

test('the metadata of each passage is what the metadata of its store reads from the other columns of its row, through get, neighbours, retrieve, retrieveMany and a filter on it', async () => {
  // Arrange
  using database = contract([
    { id: 'a', source: 'guide', seq: 0, vector: [1, 0, 0, 0], year: 2024 },
    {
      id: 'b',
      source: 'guide',
      seq: 1,
      vector: [0, 1, 0, 0],
      product: 'vault',
      year: 2025,
    },
  ]);
  const metadata = new RecordingMetadata(year);
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: metadata.read,
  });
  const retriever = new SqliteEmbeddingRetriever({
    store,
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ a: [1, 0, 0, 0], b: [0, 1, 0, 0] }),
  });

  // Act
  const byId = await store.get(['b']);
  const window = await store.neighbours({
    source: 'guide',
    seq: 0,
    windowSize: 1,
  });
  const retrieved = await retriever.retrieve('a', { topK: 1 });
  const many = await retriever.retrieveMany(['a', 'b'], { topK: 1 });
  const filtered = await retriever.retrieve('a', {
    filter: { field: 'metadata.year', operator: '>=', value: 2025 },
  });

  // Assert
  const passages = [
    ...byId.values(),
    ...window,
    ...[retrieved, ...many, filtered].flatMap(({ passages }) =>
      passages.map(({ passage }) => passage),
    ),
  ];
  assert.deepEqual(
    passages.map(({ id, metadata }) => [id, metadata]),
    [
      ['b', { year: 2025 }],
      ['a', { year: 2024 }],
      ['b', { year: 2025 }],
      ['a', { year: 2024 }],
      ['a', { year: 2024 }],
      ['b', { year: 2025 }],
      ['b', { year: 2025 }],
    ],
  );
  assert.ok(passages.every((passage) => metadata.gave(passage.metadata)));
  assert.deepEqual(metadata.columns[0], { product: 'vault', year: 2025 });
});

test('an error that the metadata of a store throws for a row is the error of each read of that row: get, neighbours, retrieve and retrieveMany reject with it', async () => {
  // Arrange
  const refused = new TypeError('A passage has no year');
  using database = contract([
    { id: 'a', vector: [1, 0, 0, 0], year: 2024 },
    { id: 'b', vector: [0, 1, 0, 0] },
  ]);
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => {
      if (columns.year === null) throw refused;
      return year(columns);
    },
  });
  const retriever = new SqliteEmbeddingRetriever({
    store,
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ a: [1, 0, 0, 0], b: [0, 1, 0, 0] }),
  });

  // Act
  const reads = await Promise.allSettled([
    store.get(['b']),
    store.neighbours({ source: 'doc-b', seq: 0, windowSize: 1 }),
    retriever.retrieve('b'),
    retriever.retrieveMany(['a', 'b'], { topK: 1 }),
  ]);
  const read = await store.get(['a']);

  // Assert
  for (const settled of reads) {
    assert.equal(
      settled.status === 'rejected' ? settled.reason : settled.value,
      refused,
    );
  }
  assert.deepEqual(read.get('a')?.metadata, { year: 2024 });
});

void test.each(
  [
    [
      'retrieve',
      async (retriever: SqliteEmbeddingRetriever) =>
        (await retriever.retrieve('toward y', { topK: 1 })).passages,
    ],
    [
      'retrieveMany',
      async (retriever: SqliteEmbeddingRetriever) =>
        (await retriever.retrieveMany(['toward y'], { topK: 1 }))[0]?.passages,
    ],
  ] as const,
  ([call, act]) =>
    test(`${call} with a model that the AI SDK's wrapEmbeddingModel gives an instruction sends the model each query after the instruction, and searches the vectors stored under the model it wraps (#5596)`, async () => {
      // Arrange: the stored vectors are of test/mini, embedded without the
      // instruction, as elt's Vectorizer embeds documents.
      using database = contract([
        { id: 'x', vector: [1, 0, 0, 0] },
        { id: 'y', vector: [0, 1, 0, 0] },
      ]);
      const instruction =
        'Instruct: Given a question, retrieve passages that answer it\nQuery:';
      const model = embeddingModel({
        [`${instruction}toward y`]: [0, 2, 1, 0],
      });
      const retriever = new SqliteEmbeddingRetriever({
        store: new SqlitePassageStore({
          database,
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        vectors: 'docs_passage_vectors',
        model: wrapEmbeddingModel({
          model,
          middleware: {
            specificationVersion: 'v4',
            transformParams: async ({ params }) => ({
              ...params,
              values: params.values.map((value) => `${instruction}${value}`),
            }),
          },
        }),
      });

      // Act
      const passages = await act(retriever);

      // Assert
      assert.deepEqual(
        passages?.map(({ passage }) => passage.id),
        ['y'],
      );
      assert.deepEqual(
        model.doEmbedCalls.map(({ values }) => values),
        [[`${instruction}toward y`]],
      );
    }),
);

void test.each(
  [
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
  ] as const,
  ([scoreThreshold]) =>
    test(`a scoreThreshold of ${scoreThreshold} is a RangeError when the retriever is made, as no score is at least NaN and a threshold that is not finite cuts no list the way the caller meant (#5734)`, () => {
      // Arrange
      using database = contract([]);
      const store = new SqlitePassageStore({
        database,
        passages: 'docs_passages',
        metadata: (columns) => columns,
      });

      // Act and Assert
      assert.throws(
        () =>
          new SqliteEmbeddingRetriever({
            store,
            vectors: 'docs_passage_vectors',
            model: embeddingModel({}),
            scoreThreshold,
          }),
        {
          name: 'RangeError',
          message: `The scoreThreshold is a finite number, not ${scoreThreshold}`,
        },
      );
    }),
);

void test.each(
  [
    [
      0.5,
      [
        ['a', 1],
        ['b', 0.5],
      ],
    ],
    [
      0,
      [
        ['a', 1],
        ['b', 0.5],
        ['c', 0],
      ],
    ],
  ] as const,
  ([scoreThreshold, kept]) =>
    test(`retrieve with a scoreThreshold of ${scoreThreshold} keeps the passages whose score is at least the threshold, an equal score too, best first (#5734)`, async () => {
      // Arrange: the scores are 1, 0.5, 0 and -1 for the query.
      using database = contract([
        { id: 'a', vector: [3, 0, 0, 0] },
        { id: 'b', vector: [1, 1, 1, 1] },
        { id: 'c', vector: [0, 1, 0, 0] },
        { id: 'd', vector: [-1, 0, 0, 0] },
      ]);
      const retriever = new SqliteEmbeddingRetriever({
        store: new SqlitePassageStore({
          database,
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        vectors: 'docs_passage_vectors',
        model: embeddingModel({ 'rotate a key': [1, 0, 0, 0] }),
        scoreThreshold,
      });

      // Act
      const { passages } = await retriever.retrieve('rotate a key');

      // Assert
      assert.deepEqual(
        passages.map(({ passage, score }) => [passage.id, score]),
        kept,
      );
    }),
);

test('retrieveMany with a scoreThreshold cuts the list of each query by the threshold (#5734)', async () => {
  // Arrange: for "rotate a key" the scores are a 1, b 0.5, c 0 and d -1;
  // for "toward c" they are c 1, b 0.5, a 0 and d 0.
  using database = contract([
    { id: 'a', vector: [3, 0, 0, 0] },
    { id: 'b', vector: [1, 1, 1, 1] },
    { id: 'c', vector: [0, 1, 0, 0] },
    { id: 'd', vector: [-1, 0, 0, 0] },
  ]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({
      'rotate a key': [1, 0, 0, 0],
      'toward c': [0, 1, 0, 0],
    }),
    scoreThreshold: 0.5,
  });

  // Act
  const lists = await retriever.retrieveMany(['rotate a key', 'toward c']);

  // Assert
  assert.deepEqual(
    lists.map(({ passages }) =>
      passages.map(({ passage, score }) => [passage.id, score]),
    ),
    [
      [
        ['a', 1],
        ['b', 0.5],
      ],
      [
        ['c', 1],
        ['b', 0.5],
      ],
    ],
  );
});

void test.each(
  [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY].flatMap((topK) =>
    (['retrieve', 'retrieveMany'] as const).map(
      (method) => [method, topK] as const,
    ),
  ),
  ([method, topK]) =>
    test(`${method} with a topK of ${topK} in the call is a RangeError before any statement runs or the model is called, as Elasticsearch refuses a bad size`, async () => {
      // Arrange: the authorizer sees each statement that SQLite compiles.
      using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
      const statements: number[] = [];
      database.setAuthorizer((action) => {
        statements.push(action);
        return constants.SQLITE_OK;
      });
      const model = embeddingModel({ 'rotate a key': [1, 0, 0, 0] });
      const retriever = new SqliteEmbeddingRetriever({
        store: new SqlitePassageStore({
          database,
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        vectors: 'docs_passage_vectors',
        model,
      });

      // Act
      const call =
        method === 'retrieve'
          ? retriever.retrieve('rotate a key', { topK })
          : retriever.retrieveMany(['rotate a key'], { topK });

      // Assert
      await assert.rejects(call, {
        name: 'RangeError',
        message: `The topK is a whole number of 0 or more, not ${topK}`,
      });
      // A length, not deepEqual: deepEqual would narrow statements to never[].
      assert.equal(statements.length, 0);
      assert.equal(model.doEmbedCalls.length, 0);
    }),
);

const blankQueries: readonly (readonly [QueryType, string])[] = [
  ['', 'The query of a query bundle holds no word: got ""'],
  [' \n\t', 'The query of a query bundle holds no word: got " \\n\\t"'],
  [{ query: '   ' }, 'The query of a query bundle holds no word: got "   "'],
  [
    { query: 'rotate a key', customEmbeddings: ['rotate a key', '  '] },
    'The customEmbeddings of a query bundle hold a text of no word: got ["rotate a key","  "]',
  ],
  [
    // @ts-expect-error: a caller with no types passes a bundle with no query
    { entrez: 'term' },
    'The query of a query bundle is not a string: got undefined',
  ],
  [
    // @ts-expect-error: a caller with no types passes a null query
    { query: null },
    'The query of a query bundle is not a string: got null',
  ],
  [
    {
      query: 'rotate a key',
      // @ts-expect-error: a caller with no types passes a number to embed
      customEmbeddings: ['rotate a key', 7],
    },
    'The customEmbeddings of a query bundle are not a list of strings: got ["rotate a key",7]',
  ],
  [
    {
      query: 'rotate a key',
      // @ts-expect-error: a caller with no types passes one text, not a list
      customEmbeddings: 'rotate a key',
    },
    'The customEmbeddings of a query bundle are not a list of strings: got "rotate a key"',
  ],
];

void test.each(
  blankQueries.flatMap(([query, message]) =>
    (['retrieve', 'retrieveMany'] as const).map(
      (method) => [method, query, message] as const,
    ),
  ),
  ([method, query, message]) =>
    test(`${method} of ${JSON.stringify(query)}, a text of no word to embed, is a RangeError before any statement runs or the model is called`, async () => {
      // Arrange: the authorizer sees each statement that SQLite compiles.
      using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
      const statements: number[] = [];
      database.setAuthorizer((action) => {
        statements.push(action);
        return constants.SQLITE_OK;
      });
      const model = embeddingModel({ 'rotate a key': [1, 0, 0, 0] });
      const retriever = new SqliteEmbeddingRetriever({
        store: new SqlitePassageStore({
          database,
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        vectors: 'docs_passage_vectors',
        model,
      });
      // Act: retrieveMany checks each query, not only the first.
      const call =
        method === 'retrieve'
          ? retriever.retrieve(query, { topK: 3 })
          : retriever.retrieveMany(['rotate a key', query], { topK: 3 });

      // Assert
      await assert.rejects(call, { name: 'RangeError', message });
      // A length, not deepEqual: deepEqual would narrow statements to never[].
      assert.equal(statements.length, 0);
      assert.equal(model.doEmbedCalls.length, 0);
    }),
);

test('retrieveMany of no queries with a topK of -1 in the call is a RangeError, not an empty list', async () => {
  // Arrange
  using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({}),
  });

  // Act
  const call = retriever.retrieveMany([], { topK: -1 });

  // Assert
  await assert.rejects(call, {
    name: 'RangeError',
    message: 'The topK is a whole number of 0 or more, not -1',
  });
});

test('a topK of 0 in the call gives no passages and makes no call to the embedding model, since no work can reach the call', async () => {
  // Arrange
  const model = embeddingModel({
    'rotate a key': [1, 0, 0, 0],
    b: [0, 1, 0, 0],
  });
  using database = contract([{ id: 'a', vector: [1, 0, 0, 0] }]);
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model,
  });

  // Act
  const result = await retriever.retrieve('rotate a key', { topK: 0 });
  const many = await retriever.retrieveMany(['rotate a key', 'b'], {
    topK: 0,
  });

  // Assert
  assert.deepEqual(result.passages, []);
  assert.deepEqual(
    many.map(({ passages }) => passages),
    [[], []],
  );
  assert.equal(model.doEmbedCalls.length, 0);
});
