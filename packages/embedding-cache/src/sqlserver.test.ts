import assert from 'node:assert/strict';
import { test } from 'node:test';

import { embedMany, wrapEmbeddingModel } from 'ai';
import { MockEmbeddingModelV4 } from 'ai/test';
import mssql from 'mssql';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import { embeddingCacheMiddleware } from './index.ts';
import {
  SqlServerEmbeddingCacheStore,
  type SqlServerSession,
} from './sqlserver.ts';

// A real embedding model cannot run in CI. The AI SDK's own mock model stands
// in for it at the provider boundary: it gives the vector that the test names
// for each text and records each call.
function model(
  vectors: Record<string, readonly number[]>,
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((text) => {
        const vector = vectors[text];
        if (vector === undefined)
          throw new Error(`The test names no vector for ${text}`);
        return [...vector];
      }),
      warnings: [],
    }),
  });
}

// The session a host writes over its own driver, as the README shows.
function session(pool: mssql.ConnectionPool): SqlServerSession {
  return {
    async query(sql, parameters) {
      const request = pool.request();
      for (const [name, value] of Object.entries(parameters))
        request.input(name, value);
      return (await request.query(sql)).recordset ?? [];
    },
  };
}

test('a hit from the SQL Server store gives exactly the numbers that the model gave', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    const numbers = [0.1, 1 / 3, -1e-300, 123456.789];
    const fake = model({ a: numbers });
    const cached = wrapEmbeddingModel({
      model: fake,
      middleware: embeddingCacheMiddleware({
        store: new SqlServerEmbeddingCacheStore({
          session: session(pool),
          table: 'dbo.embedding_cache',
        }),
      }),
    });
    await embedMany({ model: cached, values: ['a'] });

    // Act
    const { embeddings } = await embedMany({ model: cached, values: ['a'] });

    // Assert
    assert.deepEqual(
      fake.doEmbedCalls.map(({ values }) => values),
      [['a']],
    );
    assert.deepEqual(embeddings, [numbers]);
  } finally {
    await pool.close();
  }
});

test('the SQL Server store creates its table when it is missing', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    const cached = wrapEmbeddingModel({
      model: model({ a: [1, 0] }),
      middleware: embeddingCacheMiddleware({
        store: new SqlServerEmbeddingCacheStore({
          session: session(pool),
          table: 'dbo.embedding_cache',
        }),
      }),
    });

    // Act
    const { embeddings } = await embedMany({ model: cached, values: ['a'] });

    // Assert
    assert.deepEqual(embeddings, [[1, 0]]);
    const columns = await pool.request().query(`
      SELECT COLUMN_NAME AS name, DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS length
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'embedding_cache'
      ORDER BY ORDINAL_POSITION`);
    assert.deepEqual(columns.recordset, [
      { name: 'key', type: 'char', length: 64 },
      { name: 'vector', type: 'varbinary', length: -1 },
    ]);
  } finally {
    await pool.close();
  }
});

test('the SQL Server store keeps an existing table with another column and its rows', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    await pool.request().query(`
      CREATE TABLE dbo.embedding_cache ([key] CHAR(64) NOT NULL PRIMARY KEY, vector VARBINARY(MAX) NOT NULL, note NVARCHAR(100) NULL);
      INSERT INTO dbo.embedding_cache ([key], vector, note) VALUES ('host', 0x, N'kept');`);
    const fake = model({ a: [1, 0] });
    const cached = wrapEmbeddingModel({
      model: fake,
      middleware: embeddingCacheMiddleware({
        store: new SqlServerEmbeddingCacheStore({
          session: session(pool),
          table: 'dbo.embedding_cache',
        }),
      }),
    });

    // Act
    await embedMany({ model: cached, values: ['a'] });
    const { embeddings } = await embedMany({ model: cached, values: ['a'] });

    // Assert
    assert.deepEqual(embeddings, [[1, 0]]);
    assert.equal(fake.doEmbedCalls.length, 1);
    const host = await pool
      .request()
      .query(`SELECT note FROM dbo.embedding_cache WHERE [key] = 'host'`);
    assert.deepEqual(host.recordset, [{ note: 'kept' }]);
  } finally {
    await pool.close();
  }
});

test('a new SQL Server store on the same database reads the entries of an earlier one', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    await embedMany({
      model: wrapEmbeddingModel({
        model: model({ a: [0.1, 0.2] }),
        middleware: embeddingCacheMiddleware({
          store: new SqlServerEmbeddingCacheStore({
            session: session(pool),
            table: 'dbo.embedding_cache',
          }),
        }),
      }),
      values: ['a'],
    });
    const later = model({});

    // Act
    const { embeddings } = await embedMany({
      model: wrapEmbeddingModel({
        model: later,
        middleware: embeddingCacheMiddleware({
          store: new SqlServerEmbeddingCacheStore({
            session: session(pool),
            table: 'dbo.embedding_cache',
          }),
        }),
      }),
      values: ['a'],
    });

    // Assert
    assert.deepEqual(embeddings, [[0.1, 0.2]]);
    assert.equal(later.doEmbedCalls.length, 0);
  } finally {
    await pool.close();
  }
});
