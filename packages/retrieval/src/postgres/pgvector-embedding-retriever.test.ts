import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';
import type pg from 'pg';
import { toSql } from 'pgvector';

import { Postgres } from '@zukhruf/testing/postgres';
import { DimensionMismatchError } from '@zukhruf/vectors';

import { ModelMismatchError } from '../index.ts';
import {
  PgvectorEmbeddingRetriever,
  PostgresPassageStore,
  type PostgresSession,
} from '../postgres.ts';
import { embeddingModel } from '../testing/embedding-model.ts';

type Row = {
  readonly id: string;
  readonly source?: string;
  readonly seq?: number;
  readonly vector: readonly number[];
  readonly model?: string;
  readonly product?: string | null;
  readonly year?: number | null;
  readonly draft?: boolean | null;
};

const server = () =>
  new Postgres({ environment: process.env, image: 'pgvector/pgvector:pg18' });

// The passage contract as elt's Vectorizer writes it: the passages with the
// metadata columns of their source row, and the passage vectors with the
// model identity of each vector. The vector column has no dimensions, so a
// table can hold the vectors of two identities during a refresh. A vector of
// the test is not of length 1: the cosine does not depend on the length, and
// its values stay exact in float32, so each score is exact.
async function contract(pool: pg.Pool, rows: readonly Row[]): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE docs_passages (id text PRIMARY KEY, source text NOT NULL, seq integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, text text NOT NULL, product text, year integer, draft boolean);
    CREATE TABLE docs_passage_vectors (id text PRIMARY KEY REFERENCES docs_passages (id), vector vector NOT NULL, model text NOT NULL);
  `);
  for (const row of rows) {
    const seq = row.seq ?? 0;
    await pool.query(
      'INSERT INTO docs_passages VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        row.id,
        row.source ?? `doc-${row.id}`,
        seq,
        seq * 10,
        seq * 10 + 10,
        `text of ${row.id}`,
        row.product ?? null,
        row.year ?? null,
        row.draft ?? null,
      ],
    );
    await pool.query('INSERT INTO docs_passage_vectors VALUES ($1, $2, $3)', [
      row.id,
      toSql([...row.vector]),
      row.model ?? 'test/mini (4 dimensions)',
    ]);
  }
}

// The session a host writes over node-postgres, as the README shows.
const session = (pool: pg.Pool): PostgresSession => ({
  query: async (sql, parameters) =>
    (await pool.query(sql, [...parameters])).rows,
});

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test('the passages come best first, each with 1 - <=> as its score, and a tie goes to the smaller id in byte order', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  // `B` sorts before `a` in byte order, as SQLite and JavaScript sort ids,
  // and after it in the en_US collation of the server.
  await contract(pool, [
    { id: 'd', vector: [-1, 0, 0, 0] },
    { id: 'c', vector: [0, 1, 0, 0] },
    { id: 'a', vector: [2, 2, 2, 2] },
    { id: 'B', vector: [1, 1, 1, 1] },
    { id: 'top', vector: [3, 0, 0, 0] },
    { id: 'e', vector: [-1, 1, 1, 1] },
  ]);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ 'rotate a key': [1, 0, 0, 0] }),
  });

  // Act
  const results = await retriever.retrieve('rotate a key');
  // The cut of topK 2 goes through the tie of B and a.
  const cut = await retriever.retrieve('rotate a key', { topK: 2 });

  // Assert
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['top', 1],
      ['B', 0.5],
      ['a', 0.5],
      ['c', 0],
      ['e', -0.5],
      ['d', -1],
    ],
  );
  assert.deepEqual(ids(cut), ['top', 'B']);
  assert.deepEqual(results[0], {
    passage: {
      id: 'top',
      text: 'text of top',
      source: 'doc-top',
      seq: 0,
      start: 0,
      end: 10,
      metadata: { product: null, year: null, draft: null },
    },
    score: 1,
  });
});

test('a call gives 10 passages when it gives no topK, and topK passages when it gives one', async () => {
  // Arrange: passage i is less like the query as i grows.
  await using database = await server().database();
  const pool = database.pool();
  await contract(
    pool,
    Array.from({ length: 12 }, (_, i) => ({
      id: `p${String(i).padStart(2, '0')}`,
      vector: [12 - i, i, 0, 0],
    })),
  );
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
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
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'a', vector: [1, 0, 0, 0] }]);
  const otherModel = embeddingModel(
    { q: [1, 0, 0, 0] },
    { provider: 'test', modelId: 'large' },
  );
  const otherProvider = embeddingModel(
    { q: [1, 0, 0, 0] },
    { provider: 'other', modelId: 'mini' },
  );
  const retriever = (query: MockEmbeddingModelV4 | string) =>
    new PgvectorEmbeddingRetriever({
      store: new PostgresPassageStore({
        session: session(pool),
        passages: 'docs_passages',
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
  // Each rejection is handled from the start: a call that fails while
  // another is awaited would be an unhandled rejection.
  await Promise.all([
    assert.rejects(byModel, (error) => {
      assert.ok(error instanceof ModelMismatchError);
      assert.deepEqual(error.stored, { provider: 'test', modelId: 'mini' });
      assert.deepEqual(error.query, { provider: 'test', modelId: 'large' });
      assert.equal(
        error.message,
        'The query model test/large is not the model of the stored vectors, test/mini',
      );
      return true;
    }),
    assert.rejects(byProvider, (error) => {
      assert.ok(error instanceof ModelMismatchError);
      assert.deepEqual(error.query, { provider: 'other', modelId: 'mini' });
      return true;
    }),
    assert.rejects(byString, (error) => {
      assert.ok(error instanceof ModelMismatchError);
      assert.deepEqual(error.query, { provider: 'test', modelId: 'large' });
      return true;
    }),
  ]);
  assert.equal(otherModel.doEmbedCalls.length, 0);
  assert.equal(otherProvider.doEmbedCalls.length, 0);
});

test('with two stored identities, ModelMismatchError names the first in the byte order of its text', async () => {
  // Arrange: `test/Mini` sorts before `test/large` in byte order, and after
  // it in the en_US collation of the server.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'a', vector: [1, 0], model: 'test/large (2 dimensions)' },
    { id: 'b', vector: [1, 0, 0, 0], model: 'test/Mini (4 dimensions)' },
  ]);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
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
    assert.deepEqual(error.stored, { provider: 'test', modelId: 'Mini' });
    return true;
  });
});

test('a query vector of other dimensions fails with DimensionMismatchError after the model call, and sends no search', async () => {
  // Arrange: the model has stored vectors of 4 and of 3 dimensions.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'a', vector: [1, 0, 0, 0] },
    { id: 'b', vector: [1, 0, 0], model: 'test/mini (3 dimensions)' },
  ]);
  const query = embeddingModel({ q: [1, 0] });
  const sent: string[] = [];
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: {
        query: (sql, parameters) => {
          sent.push(sql);
          return session(pool).query(sql, parameters);
        },
      },
      passages: 'docs_passages',
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const result = retriever.retrieve('q');

  // Assert
  // `expected` is the first stored identity of the model in the order of its text.
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof DimensionMismatchError);
    assert.equal(error.expected, 3);
    assert.equal(error.actual, 2);
    return true;
  });
  assert.equal(query.doEmbedCalls.length, 1);
  assert.deepEqual(
    sent.filter((sql) => sql.includes('<=>')),
    [],
  );
});

test('a query compares only with the vectors of its own model identity when the table holds two', async () => {
  // Arrange: elt is in the middle of a refresh to 2 dimensions. pgvector
  // refuses to compare vectors of two dimensions, so a query that reached
  // the old vectors would fail.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'old', vector: [1, 0, 0, 0] },
    { id: 'new-far', vector: [0, 1], model: 'test/mini (2 dimensions)' },
    { id: 'new-near', vector: [1, 0], model: 'test/mini (2 dimensions)' },
    { id: 'other', vector: [1, 0], model: 'test/large (2 dimensions)' },
  ]);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
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
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'a', vector: [1, 0, 0, 0], model: 'text-embedding-3-small' },
  ]);
  const query = embeddingModel({ q: [1, 0, 0, 0] });
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const result = retriever.retrieve('q');
  const withoutProvider = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
    vectors: 'docs_passage_vectors',
    model: 'mini',
  }).retrieve('q');

  // Assert
  // Each rejection is handled from the start: a call that fails while
  // another is awaited would be an unhandled rejection.
  await Promise.all([
    assert.rejects(result, {
      name: 'TypeError',
      message:
        'The stored model "text-embedding-3-small" is not a model identity of the form "provider/model (n dimensions)"',
    }),
    assert.rejects(withoutProvider, {
      name: 'TypeError',
      message: 'The model id "mini" names no provider: write "provider/model"',
    }),
  ]);
  assert.equal(query.doEmbedCalls.length, 0);
});

test('an empty vector table gives no passages and makes no model call', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, []);
  const query = embeddingModel({ q: [1, 0, 0, 0] });
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
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

test('retrieveMany of no queries gives no lists', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'x', vector: [1, 0, 0, 0] }]);
  const query = embeddingModel({});
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const lists = await retriever.retrieveMany([]);

  // Assert
  assert.deepEqual(lists, []);
  assert.equal(query.doEmbedCalls.length, 0);
});

test('includeVectors gives the stored vector of each passage, and no call gives it otherwise', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'a', vector: [3, 0, 0, 0] },
    { id: 'b', vector: [0.5, -0.25, 1, 2] },
  ]);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
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

test('retrieveMany embeds the queries in one model call, searches them in one SQL statement and gives one list for each query, in the order of the queries', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'x', vector: [1, 0, 0, 0] },
    { id: 'y', vector: [0, 1, 0, 0] },
    { id: 'z', vector: [0, 0, 1, 0] },
  ]);
  const query = embeddingModel({
    'toward y': [0, 2, 1, 0],
    'toward x': [2, 0, 1, 0],
    'toward z': [0, 0, 1, 0],
  });
  const sent: string[] = [];
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: {
        query: (sql, parameters) => {
          sent.push(sql);
          return session(pool).query(sql, parameters);
        },
      },
      passages: 'docs_passages',
    }),
    vectors: 'docs_passage_vectors',
    model: query,
  });

  // Act
  const lists = await retriever.retrieveMany(
    ['toward y', 'toward x', 'toward z'],
    { topK: 2 },
  );
  const searches = sent.filter((sql) => sql.includes('<=>')).length;
  const one = await retriever.retrieve('toward x', { topK: 2 });

  // Assert
  assert.deepEqual(lists.map(ids), [
    ['y', 'z'],
    ['x', 'z'],
    ['z', 'x'],
  ]);
  assert.deepEqual(lists[1], one);
  assert.equal(searches, 1);
  assert.deepEqual(
    query.doEmbedCalls.map(({ values }) => values),
    [['toward y', 'toward x', 'toward z'], ['toward x']],
  );
});

test('an aborted call rejects with the reason of its signal, before the model call and after it', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'x', vector: [1, 0, 0, 0] }]);
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
    new PgvectorEmbeddingRetriever({
      store: new PostgresPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
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
  // Each rejection is handled from the start: a call that fails while
  // another is awaited would be an unhandled rejection.
  await Promise.all([
    assert.rejects(early, (error) => error === reason),
    assert.rejects(late, (error) => error === controller.signal.reason),
  ]);
  assert.equal(before.doEmbedCalls.length, 0);
  assert.equal(during.doEmbedCalls[0]?.abortSignal, controller.signal);
});

test('each filter operator selects the passages it names, on passage fields and on metadata columns, with NULL compared as a value', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
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
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
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
    notInEmpty: await filtered({
      filter: { field: 'metadata.product', operator: 'not in', value: [] },
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
    notInEmpty: ['a', 'b', 'c', 'd'],
    start: ['c'],
    end: ['b'],
  });
});

test('AND, OR and NOT nest, NOT negates all its conditions, and a boolean value compares with a boolean column', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    {
      id: 'a',
      vector: [1, 0, 0, 0],
      product: 'vault',
      year: 2024,
      draft: true,
    },
    {
      id: 'b',
      vector: [1, 0, 0, 0],
      product: 'vault',
      year: 2026,
      draft: false,
    },
    { id: 'c', vector: [1, 0, 0, 0], product: 'boundary', year: 2026 },
    { id: 'd', vector: [1, 0, 0, 0], product: 'consul', year: 1, draft: true },
  ]);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
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
      filter: { field: 'metadata.draft', operator: '==', value: true },
    }),
    notFalse: await filtered({
      filter: { field: 'metadata.draft', operator: '!=', value: false },
    }),
    emptyAnd: await filtered({ filter: { operator: 'AND', conditions: [] } }),
    emptyOr: await filtered({ filter: { operator: 'OR', conditions: [] } }),
  };

  // Assert
  assert.deepEqual(results, {
    and: ['a'],
    not: ['a', 'c', 'd'],
    or: ['a', 'd'],
    true: ['a', 'd'],
    notFalse: ['a', 'c', 'd'],
    emptyAnd: ['a', 'b', 'c', 'd'],
    emptyOr: [],
  });
});

test('SQL in a filter field stays one column name, and SQL in a filter value stays a value', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'a', vector: [1, 0, 0, 0], product: 'vault' }]);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ q: [1, 0, 0, 0] }),
  });

  // Act
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
  const byField = retriever.retrieve('q', {
    filter: {
      field: 'metadata.product" IS NOT NULL OR "1',
      operator: '==',
      value: 'none',
    },
  });

  // Assert
  // The engine looks for one column with the whole field as its name.
  await assert.rejects(byField, {
    message: 'column p.product" IS NOT NULL OR "1 does not exist',
  });
  assert.deepEqual(byValue, []);
  assert.deepEqual(bySetValue, []);
});

test('a filter field that is not a passage field or a metadata column, a value SQL cannot hold and an in filter without a list fail the call', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'a', vector: [1, 0, 0, 0] }]);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
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
  // Each rejection is handled from the start: a call that fails while
  // another is awaited would be an unhandled rejection.
  await Promise.all([
    assert.rejects(byField, {
      name: 'TypeError',
      message:
        'The filter field "text" is not source, seq, start, end or metadata.<column>',
    }),
    assert.rejects(byObject, {
      name: 'TypeError',
      message:
        'A filter value is a string, a number, a bigint, a boolean or null, not [object Object]',
    }),
    assert.rejects(byValue, {
      name: 'TypeError',
      message:
        'The value of an "not in" filter on source is an array, not "doc-a"',
    }),
  ]);
});

test('a metadata column keeps its name and value even when it has the name of a cell that the search adds, and a tsvector column is not metadata', async () => {
  // Arrange: names that need quoting, and metadata columns with the names of
  // the cells beside the passage in the search.
  await using database = await server().database();
  const pool = database.pool();
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE "docs ""passages""" (id text PRIMARY KEY, source text, seq integer, start integer, "end" integer, text text, distance text, vector text, passage text, query text, keywords tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED);
    CREATE TABLE "docs vectors" (id text PRIMARY KEY, vector vector NOT NULL, model text NOT NULL);
    INSERT INTO "docs ""passages""" VALUES ('a', 's', 0, 0, 4, 'text', 'far', 'none', 'whole', 'who');
    INSERT INTO "docs vectors" VALUES ('a', '[1,0]', 'test/mini (2 dimensions)');
  `);
  const retriever = new PgvectorEmbeddingRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs "passages"',
    }),
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
    passage: 'whole',
    query: 'who',
  });
  assert.equal(result?.score, 1);
});

test('a store with a schema searches the passages and the passage vectors of that schema, and a store without one finds them through the search_path of the session', async () => {
  // Arrange: the same contract in public, which the search_path finds, and
  // in a second schema, each with passages and vectors of its own.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'public-a', vector: [1, 0, 0, 0] }]);
  await pool.query(`
    CREATE SCHEMA rag;
    CREATE TABLE rag.docs_passages (LIKE public.docs_passages INCLUDING ALL);
    CREATE TABLE rag.docs_passage_vectors (LIKE public.docs_passage_vectors INCLUDING ALL);
    INSERT INTO rag.docs_passages (id, source, seq, start, "end", text) VALUES ('rag-a', 'doc-rag-a', 0, 0, 10, 'text of rag-a');
    INSERT INTO rag.docs_passage_vectors VALUES ('rag-a', '[2,0,0,0]', 'test/mini (4 dimensions)');
  `);
  const retriever = (store: PostgresPassageStore) =>
    new PgvectorEmbeddingRetriever({
      store,
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });

  // Act
  const fromSchema = await retriever(
    new PostgresPassageStore({
      session: session(pool),
      schema: 'rag',
      passages: 'docs_passages',
    }),
  ).retrieve('q');
  const fromSearchPath = await retriever(
    new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
    }),
  ).retrieve('q');

  // Assert
  assert.deepEqual(fromSchema, [
    {
      passage: {
        id: 'rag-a',
        text: 'text of rag-a',
        source: 'doc-rag-a',
        seq: 0,
        start: 0,
        end: 10,
        metadata: { product: null, year: null, draft: null },
      },
      score: 1,
    },
  ]);
  assert.deepEqual(ids(fromSearchPath), ['public-a']);
});

test('two stores on two databases, alive at once, each search the passages of their own session', async () => {
  // Arrange: both stores exist before either retriever, and their rows differ.
  await using first = await server().database();
  await using second = await server().database();
  await contract(first.pool(), [{ id: 'first-a', vector: [1, 0, 0, 0] }]);
  await contract(second.pool(), [{ id: 'second-a', vector: [1, 0, 0, 0] }]);
  const firstStore = new PostgresPassageStore({
    session: session(first.pool()),
    passages: 'docs_passages',
  });
  const secondStore = new PostgresPassageStore({
    session: session(second.pool()),
    passages: 'docs_passages',
  });
  const retriever = (store: PostgresPassageStore) =>
    new PgvectorEmbeddingRetriever({
      store,
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });
  const fromFirst = retriever(firstStore);
  const fromSecond = retriever(secondStore);

  // Act
  const firstResults = await fromFirst.retrieve('q');
  const secondResults = await fromSecond.retrieve('q');

  // Assert
  assert.deepEqual(ids(firstResults), ['first-a']);
  assert.deepEqual(ids(secondResults), ['second-a']);
});
