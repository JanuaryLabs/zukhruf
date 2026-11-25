import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';
import type mssql from 'mssql';

import { SqlServer } from '@zukhruf/testing/sqlserver';
import { DimensionMismatchError } from '@zukhruf/vectors';

import { ModelMismatchError } from '../index.ts';
import {
  SqlServerEmbeddingRetriever,
  SqlServerPassageStore,
  type SqlServerSession,
} from '../sqlserver.ts';
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
  new SqlServer({
    environment: process.env,
    image: 'mcr.microsoft.com/mssql/server:2025-latest',
    fullTextSearch: true,
  });

// SQL Server 2025 crashes at start about once in 41 starts when an arm64
// engine emulates amd64 (#5469), so a test that runs it runs only where the
// engine runs amd64 natively, as on CI.
const emulation = await SqlServer.emulation({ environment: process.env });

// The passage contract as elt's Vectorizer writes it: the passages with the
// metadata columns of their source row, and the passage vectors with the
// model identity of each vector. The ids compare in binary; the model and
// the other text columns keep the case-insensitive collation of the server.
// A SQL Server vector column has its dimensions in its type, so a table
// holds vectors of one number of dimensions. A vector of the test is not of
// length 1: the cosine does not depend on the length, and its values stay
// exact in float32, so each score is exact.
//
// With `ids: 'server'`, the id columns keep the case-insensitive collation
// of the server, as a contract that does not name a collation has them. They
// then have no key: a key in that collation refuses ids that differ only in
// case (error 2627).
async function contract(
  pool: mssql.ConnectionPool,
  rows: readonly Row[],
  {
    schema = 'dbo',
    dimensions = 4,
    ids = 'binary',
  }: { schema?: string; dimensions?: number; ids?: 'binary' | 'server' } = {},
): Promise<void> {
  const [passagesId, vectorsId] =
    ids === 'binary'
      ? [
          'NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY',
          `NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY REFERENCES [${schema}].docs_passages (id)`,
        ]
      : ['NVARCHAR(450) NOT NULL', 'NVARCHAR(450) NOT NULL'];
  await pool.request().batch(`
    CREATE TABLE [${schema}].docs_passages (id ${passagesId}, source NVARCHAR(400) NOT NULL, seq INT NOT NULL, start INT NOT NULL, [end] INT NOT NULL, text NVARCHAR(MAX) NOT NULL, product NVARCHAR(100), year INT, draft BIT);
    CREATE TABLE [${schema}].docs_passage_vectors (id ${vectorsId}, vector VECTOR(${dimensions}) NOT NULL, model NVARCHAR(400) NOT NULL);
  `);
  for (const row of rows) {
    const seq = row.seq ?? 0;
    await pool
      .request()
      .input('id', row.id)
      .input('source', row.source ?? `doc-${row.id}`)
      .input('seq', seq)
      .input('start', seq * 10)
      .input('end', seq * 10 + 10)
      .input('text', `text of ${row.id}`)
      .input('product', row.product ?? null)
      .input('year', row.year ?? null)
      .input('draft', row.draft ?? null)
      .query(
        `INSERT INTO [${schema}].docs_passages VALUES (@id, @source, @seq, @start, @end, @text, @product, @year, @draft)`,
      );
    await pool
      .request()
      .input('id', row.id)
      .input('vector', JSON.stringify(row.vector))
      .input('model', row.model ?? 'test/mini (4 dimensions)')
      .query(
        `INSERT INTO [${schema}].docs_passage_vectors VALUES (@id, CAST(@vector AS VECTOR(${dimensions})), @model)`,
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

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test(
  'the passages come best first, each with 1 - VECTOR_DISTANCE as its score, and a tie goes to the smaller id in binary order',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    // `B` sorts before `a` in binary order, as SQLite and JavaScript sort ids,
    // and after it in the case-insensitive collation of the server.
    await contract(pool, [
      { id: 'd', vector: [-1, 0, 0, 0] },
      { id: 'c', vector: [0, 1, 0, 0] },
      { id: 'a', vector: [2, 2, 2, 2] },
      { id: 'B', vector: [1, 1, 1, 1] },
      { id: 'top', vector: [3, 0, 0, 0] },
      { id: 'e', vector: [-1, 1, 1, 1] },
    ]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ 'rotate a key': [1, 0, 0, 0] }),
    });

    // Act
    const results = (await retriever.retrieve('rotate a key')).passages;
    // The cut of topK 2 goes through the tie of B and a.
    const cut = (await retriever.retrieve('rotate a key', { topK: 2 }))
      .passages;

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
  },
);

test(
  'when the id columns are case-insensitive, ids that differ only in case stay two passages, each with its own vector, and a tie still goes to the smaller id in binary order',
  { skip: emulation },
  async () => {
    // Arrange: `a` and `A` are one id in the collation of the columns, and `B`
    // sorts after `a` in it.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(
      pool,
      [
        { id: 'a', vector: [1, 1, 1, 1] },
        { id: 'A', vector: [1, 0, 0, 0] },
        { id: 'B', vector: [2, 2, 2, 2] },
      ],
      { ids: 'server' },
    );
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });

    // Act
    const results = (await retriever.retrieve('q')).passages;
    // The cut of topK 2 goes through the tie of B and a.
    const cut = (await retriever.retrieve('q', { topK: 2 })).passages;
    const [many] = (await retriever.retrieveMany(['q'], { topK: 2 })).map(
      ({ passages }) => passages,
    );

    // Assert
    assert.deepEqual(
      results.map(({ passage, score }) => [passage.id, passage.text, score]),
      [
        ['A', 'text of A', 1],
        ['B', 'text of B', 0.5],
        ['a', 'text of a', 0.5],
      ],
    );
    assert.deepEqual(ids(cut), ['A', 'B']);
    assert.deepEqual(many, cut);
  },
);

test(
  'a call gives 10 passages when it gives no topK, and topK passages when it gives one',
  { skip: emulation },
  async () => {
    // Arrange: passage i is less like the query as i grows.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(
      pool,
      Array.from({ length: 12 }, (_, i) => ({
        id: `p${String(i).padStart(2, '0')}`,
        vector: [12 - i, i, 0, 0],
      })),
    );
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });

    // Act
    const byDefault = (await retriever.retrieve('q')).passages;
    const three = (await retriever.retrieve('q', { topK: 3 })).passages;
    const none = (await retriever.retrieve('q', { topK: 0 })).passages;

    // Assert
    assert.deepEqual(
      ids(byDefault),
      Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, '0')}`),
    );
    assert.deepEqual(ids(three), ['p00', 'p01', 'p02']);
    assert.deepEqual(none, []);
  },
);

test(
  'a query model of another provider or model id fails with ModelMismatchError before any model call',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
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
      new SqlServerEmbeddingRetriever({
        store: new SqlServerPassageStore({
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
  },
);

test(
  'with two stored identities, ModelMismatchError names the first in the binary order of its text',
  { skip: emulation },
  async () => {
    // Arrange: `test/Mini` sorts before `test/large` in binary order, and after
    // it in the case-insensitive collation of the server.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'a', vector: [1, 0, 0, 0], model: 'test/large (4 dimensions)' },
      { id: 'b', vector: [1, 0, 0, 0], model: 'test/Mini (4 dimensions)' },
    ]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
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
  },
);

test(
  'a query vector of other dimensions fails with DimensionMismatchError after the model call, and sends no search',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [{ id: 'a', vector: [1, 0, 0, 0] }]);
    const query = embeddingModel({ q: [1, 0] });
    const sent: string[] = [];
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
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
    await assert.rejects(result, (error) => {
      assert.ok(error instanceof DimensionMismatchError);
      assert.equal(error.expected, 4);
      assert.equal(error.actual, 2);
      return true;
    });
    assert.equal(query.doEmbedCalls.length, 1);
    assert.deepEqual(
      sent.filter((sql) => sql.includes('VECTOR_DISTANCE')),
      [],
    );
  },
);

test(
  'a query compares only with the vectors of its own model identity, in binary, when the table holds others',
  { skip: emulation },
  async () => {
    // Arrange: elt is in the middle of a refresh to another model of the same
    // dimensions, and a third identity differs from the query's only in case,
    // which the case-insensitive collation of the server would call equal.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'other', vector: [1, 0, 0, 0], model: 'test/large (4 dimensions)' },
      { id: 'upper', vector: [1, 0, 0, 0], model: 'TEST/MINI (4 dimensions)' },
      { id: 'far', vector: [0, 1, 0, 0] },
      { id: 'near', vector: [1, 1, 0, 0] },
    ]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });

    // Act
    const results = (await retriever.retrieve('q')).passages;

    // Assert
    assert.deepEqual(ids(results), ['near', 'far']);
  },
);

test(
  'a stored model that is not a model identity, and a string model id without a provider, fail the call before any model call',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'a', vector: [1, 0, 0, 0], model: 'text-embedding-3-small' },
    ]);
    const query = embeddingModel({ q: [1, 0, 0, 0] });
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: query,
    });

    // Act
    const result = retriever.retrieve('q');
    const withoutProvider = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
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
        message:
          'The model id "mini" names no provider: write "provider/model"',
      }),
    ]);
    assert.equal(query.doEmbedCalls.length, 0);
  },
);

test(
  'an empty vector table gives no passages and makes no model call',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, []);
    const query = embeddingModel({ q: [1, 0, 0, 0] });
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
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
  },
);

test(
  'retrieveMany of no queries gives no lists',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [{ id: 'x', vector: [1, 0, 0, 0] }]);
    const query = embeddingModel({});
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
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
  },
);

test(
  'includeVectors gives the stored vector of each passage, and no call gives it otherwise',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'a', vector: [3, 0, 0, 0] },
      { id: 'b', vector: [0.5, -0.25, 1, 2] },
    ]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });

    // Act
    const withVectors = (
      await retriever.retrieve('q', { includeVectors: true })
    ).passages;
    const without = (await retriever.retrieve('q')).passages;
    const [many] = (
      await retriever.retrieveMany(['q'], {
        includeVectors: true,
      })
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
  },
);

test(
  'retrieveMany embeds the queries in one model call, searches them in one SQL statement and gives one list for each query, in the order of the queries',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
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
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
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
    const lists = (
      await retriever.retrieveMany(['toward y', 'toward x', 'toward z'], {
        topK: 2,
      })
    ).map(({ passages }) => passages);
    const searches = sent.filter((sql) =>
      sql.includes('VECTOR_DISTANCE'),
    ).length;
    const one = (await retriever.retrieve('toward x', { topK: 2 })).passages;

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
  },
);

test(
  'the texts of customEmbeddings are embedded in place of query, and two texts search with the mean of their vectors, in retrieve and in each query of retrieveMany',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'x', vector: [1, 0, 0, 0] },
      { id: 'xy', vector: [1, 1, 0, 0] },
      { id: 'y', vector: [0, 1, 0, 0] },
    ]);
    const query = embeddingModel({
      'toward x': [2, 0, 0, 0],
      'toward y': [0, 2, 0, 0],
    });
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
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
  },
);

test(
  'a batch of more queries than SQL Server takes parameters searches in one statement',
  { skip: emulation },
  async () => {
    // Arrange: SQL Server refuses a statement of more than 2,100 parameters.
    // Query i points from x toward y as i grows, so each query has its own
    // scores, and a query that got the vector of another would show.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      { id: 'x', vector: [1, 0, 0, 0] },
      { id: 'y', vector: [0, 1, 0, 0] },
    ]);
    const count = 2200;
    const vectorOf = (i: number) => [count - i, i + 1, 0, 0];
    const queries = Array.from({ length: count }, (_, i) => `q${i}`);
    const sent: string[] = [];
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: {
          query: (sql, parameters) => {
            sent.push(sql);
            return session(pool).query(sql, parameters);
          },
        },
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel(
        Object.fromEntries(queries.map((text, i) => [text, vectorOf(i)])),
      ),
    });

    // Act
    const lists = (await retriever.retrieveMany(queries, { topK: 2 })).map(
      ({ passages }) => passages,
    );

    // Assert
    // The cosine of query i to x and to y. float32 keeps them to about 1e-7,
    // and two neighbouring queries differ by more than 1e-4 in one of them.
    const expected = (i: number) => {
      const [toX = 0, toY = 0] = vectorOf(i);
      const length = Math.hypot(toX, toY);
      const scores: [string, number][] = [
        ['x', toX / length],
        ['y', toY / length],
      ];
      return scores.toSorted(([, a], [, b]) => b - a);
    };
    const wrong = lists.flatMap((list, i) => {
      const want = expected(i);
      const right =
        list.length === want.length &&
        list.every(
          ({ passage, score }, rank) =>
            passage.id === want[rank]?.[0] &&
            Math.abs((score ?? Number.NaN) - (want[rank]?.[1] ?? Number.NaN)) <
              1e-5,
        );
      return right ? [] : [i];
    });
    assert.equal(lists.length, count);
    assert.deepEqual(wrong, []);
    assert.equal(
      sent.filter((sql) => sql.includes('VECTOR_DISTANCE')).length,
      1,
    );
  },
);

test(
  'an aborted call rejects with the reason of its signal, before the model call and after it',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
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
      new SqlServerEmbeddingRetriever({
        store: new SqlServerPassageStore({
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
  },
);

test(
  'each filter operator selects the passages it names, on passage fields and on metadata columns, with NULL compared as a value',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
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
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
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
      less: await filtered({
        filter: { field: 'seq', operator: '<', value: 1 },
      }),
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
      bigint: await filtered({
        filter: { field: 'metadata.year', operator: '==', value: 2026n },
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
      bigint: ['c'],
    });
  },
);

test(
  'the filter selects the passages before the cut of topK, so the passages it selects come even when more than topK others rank above them',
  { skip: emulation },
  async () => {
    // Arrange: 12 passages of another product rank above the 2 of the filter.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `other${String(i).padStart(2, '0')}`,
        vector: [1, 0, 0, 0],
        product: 'consul',
      })),
      { id: 'v1', vector: [1, 1, 0, 0], product: 'vault' },
      { id: 'v2', vector: [0, 1, 0, 0], product: 'vault' },
    ]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });
    const filter = {
      field: 'metadata.product',
      operator: '==',
      value: 'vault',
    } as const;

    // Act
    const byDefault = (await retriever.retrieve('q', { filter })).passages;
    const one = (await retriever.retrieve('q', { filter, topK: 1 })).passages;
    const [many] = (
      await retriever.retrieveMany(['q'], { filter, topK: 2 })
    ).map(({ passages }) => passages);

    // Assert
    assert.deepEqual(ids(byDefault), ['v1', 'v2']);
    assert.deepEqual(ids(one), ['v1']);
    assert.deepEqual(many, byDefault);
  },
);

test(
  'AND, OR and NOT nest, NOT negates all its conditions, and a boolean value compares with a BIT column',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
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
      {
        id: 'd',
        vector: [1, 0, 0, 0],
        product: 'consul',
        year: 1,
        draft: true,
      },
    ]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
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
                {
                  field: 'metadata.product',
                  operator: '==',
                  value: 'boundary',
                },
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
      notEmptyAnd: await filtered({
        filter: {
          operator: 'NOT',
          conditions: [{ operator: 'AND', conditions: [] }],
        },
      }),
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
      notEmptyAnd: [],
    });
  },
);

test(
  'SQL in a filter field stays one column name, and SQL in a filter value stays a value',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [{ id: 'a', vector: [1, 0, 0, 0], product: 'vault' }]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
      }),
      vectors: 'docs_passage_vectors',
      model: embeddingModel({ q: [1, 0, 0, 0] }),
    });

    // Act
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
    const byField = retriever.retrieve('q', {
      filter: {
        field: 'metadata.product] IS NOT NULL OR [1',
        operator: '==',
        value: 'none',
      },
    });

    // Assert
    // The engine looks for one column with the whole field as its name.
    await assert.rejects(byField, {
      number: 207,
      message: "Invalid column name 'product] IS NOT NULL OR [1'.",
    });
    assert.deepEqual(byValue, []);
    assert.deepEqual(bySetValue, []);
  },
);

test(
  'a filter field that is not a passage field or a metadata column, a value SQL cannot hold and an in filter without a list fail the call',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [{ id: 'a', vector: [1, 0, 0, 0] }]);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs_passages',
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
  },
);

test(
  'a metadata column keeps its name and value even when it has the name of a cell that the search adds',
  { skip: emulation },
  async () => {
    // Arrange: names that need quoting, and metadata columns with the names of
    // the cells beside the passage in the search.
    await using database = await server().database();
    const pool = await database.pool();
    await pool.request().batch(`
    CREATE TABLE [docs ]]passages]]] (id NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY, source NVARCHAR(400), seq INT, start INT, [end] INT, text NVARCHAR(MAX), distance NVARCHAR(10), vector NVARCHAR(10), passage NVARCHAR(10), query NVARCHAR(10));
    CREATE TABLE [docs vectors] (id NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY, vector VECTOR(2) NOT NULL, model NVARCHAR(400) NOT NULL);
    INSERT INTO [docs ]]passages]]] VALUES (N'a', N's', 0, 0, 4, N'text', N'far', N'none', N'whole', N'who');
    INSERT INTO [docs vectors] VALUES (N'a', CAST(N'[1,0]' AS VECTOR(2)), N'test/mini (2 dimensions)');
  `);
    const retriever = new SqlServerEmbeddingRetriever({
      store: new SqlServerPassageStore({
        session: session(pool),
        passages: 'docs ]passages]',
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
      passage: 'whole',
      query: 'who',
    });
    assert.equal(result?.score, 1);
  },
);

test(
  'a store with a schema searches the passages and the passage vectors of that schema, and a store without one finds them through the default schema of the user',
  { skip: emulation },
  async () => {
    // Arrange: the same contract in dbo, the default schema of the user, and
    // in a second schema, each with passages and vectors of its own.
    await using database = await server().database();
    const pool = await database.pool();
    await contract(pool, [{ id: 'dbo-a', vector: [1, 0, 0, 0] }]);
    // CREATE SCHEMA is the only statement of its batch.
    await pool.request().batch('CREATE SCHEMA rag');
    await contract(pool, [{ id: 'rag-a', vector: [2, 0, 0, 0] }], {
      schema: 'rag',
    });
    const retriever = (store: SqlServerPassageStore) =>
      new SqlServerEmbeddingRetriever({
        store,
        vectors: 'docs_passage_vectors',
        model: embeddingModel({ q: [1, 0, 0, 0] }),
      });

    // Act
    const fromSchema = (
      await retriever(
        new SqlServerPassageStore({
          session: session(pool),
          schema: 'rag',
          passages: 'docs_passages',
        }),
      ).retrieve('q')
    ).passages;
    const fromDefault = (
      await retriever(
        new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
        }),
      ).retrieve('q')
    ).passages;

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
    assert.deepEqual(ids(fromDefault), ['dbo-a']);
  },
);

test(
  'two stores on two databases, alive at once, each search the passages of their own session',
  { skip: emulation },
  async () => {
    // Arrange: both stores exist before either retriever, and their rows differ.
    await using first = await server().database();
    await using second = await server().database();
    const firstPool = await first.pool();
    const secondPool = await second.pool();
    await contract(firstPool, [{ id: 'first-a', vector: [1, 0, 0, 0] }]);
    await contract(secondPool, [{ id: 'second-a', vector: [1, 0, 0, 0] }]);
    const firstStore = new SqlServerPassageStore({
      session: session(firstPool),
      passages: 'docs_passages',
    });
    const secondStore = new SqlServerPassageStore({
      session: session(secondPool),
      passages: 'docs_passages',
    });
    const retriever = (store: SqlServerPassageStore) =>
      new SqlServerEmbeddingRetriever({
        store,
        vectors: 'docs_passage_vectors',
        model: embeddingModel({ q: [1, 0, 0, 0] }),
      });
    const fromFirst = retriever(firstStore);
    const fromSecond = retriever(secondStore);

    // Act
    const firstResults = (await fromFirst.retrieve('q')).passages;
    const secondResults = (await fromSecond.retrieve('q')).passages;

    // Assert
    assert.deepEqual(ids(firstResults), ['first-a']);
    assert.deepEqual(ids(secondResults), ['second-a']);
  },
);
