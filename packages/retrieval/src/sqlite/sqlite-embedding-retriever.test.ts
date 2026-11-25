import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { DimensionMismatchError, Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import { ModelMismatchError } from '../index.ts';
import { SqliteEmbeddingRetriever, SqlitePassageStore } from '../sqlite.ts';
import { embeddingModel } from '../testing/embedding-model.ts';

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ 'rotate a key': [1, 0, 0, 0] }),
  });

  // Act
  const results = await retriever.retrieve('rotate a key');

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
  const byDefault = await retriever.retrieve('q');
  const three = await retriever.retrieve('q', { topK: 3 });

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
      store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0] }),
  });

  // Act
  const results = await retriever.retrieve('q');

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
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
      store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const one = await retriever.retrieve('q');
  const many = await retriever.retrieveMany(['q', 'q']);

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
  const withVectors = await retriever.retrieve('q', { includeVectors: true });
  const without = await retriever.retrieve('q');
  const [many] = await retriever.retrieveMany(['q'], { includeVectors: true });

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const lists = await retriever.retrieveMany(
    ['toward y', 'toward x', 'toward z'],
    { topK: 2 },
  );
  const one = await retriever.retrieve('toward x', { topK: 2 });

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act: the model knows no vector for the query of a bundle.
  const both = {
    query: 'how do I rotate a key?',
    customEmbeddings: ['toward x', 'toward y'],
  } as const;
  const one = await retriever.retrieve(both);
  const lists = await retriever.retrieveMany([
    both,
    { query: 'how do I rotate a key?', customEmbeddings: ['toward y'] },
    'toward x',
  ]);

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

test('retrieveMany of no queries gives no lists', async () => {
  // Arrange
  using database = contract([{ id: 'x', vector: [1, 0, 0, 0] }]);
  const query = embeddingModel({});
  const retriever = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const lists = await retriever.retrieveMany([]);

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
      store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
      vectors: 'docs_passage_vectors',
      model: query,
    });
  const reason = new Error('cancelled');

  // Act
  const early = retriever(before).retrieve('q', {
    abortSignal: AbortSignal.abort(reason),
  });
  const late = retriever(during).retrieve('q', {
    abortSignal: controller.signal,
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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });
  const filtered = async (filter: Parameters<typeof retriever.retrieve>[1]) =>
    ids(await retriever.retrieve('q', filter)).toSorted();

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });
  const filtered = async (filter: Parameters<typeof retriever.retrieve>[1]) =>
    ids(await retriever.retrieve('q', filter)).toSorted();

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
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
  const byValue = await retriever.retrieve('q', {
    filter: {
      field: 'metadata.product',
      operator: '==',
      value: "none' OR 1 = 1 OR product = '",
    },
  });
  const bySetValue = await retriever.retrieve('q', {
    filter: {
      field: 'metadata.product',
      operator: 'in',
      value: ["x') OR 1 = 1 --"],
    },
  });

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
    store: new SqlitePassageStore({ database, passages: 'docs_passages' }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
  // A caller without the types of the package can pass any field and value.
  const byField = Reflect.apply(retriever.retrieve, retriever, [
    'q',
    { filter: { field: 'text', operator: '==', value: 'x' } },
  ]);
  const byObject = retriever.retrieve('q', {
    filter: { field: 'source', operator: '==', value: { id: 'x' } },
  });
  const byValue = retriever.retrieve('q', {
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
    store: new SqlitePassageStore({ database, passages: 'docs "passages"' }),
    vectors: 'docs vectors',
    model: embeddingModel({ q: [1, 0] }),
  });

  // Act
  const [result] = await retriever.retrieve('q', {
    filter: { field: 'metadata.distance', operator: '==', value: 'far' },
  });

  // Assert
  assert.deepEqual(result?.passage.metadata, {
    distance: 'far',
    vector: 'none',
    query: 'who',
  });
  assert.equal(result?.score, 1);
});
