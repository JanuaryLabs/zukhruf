import assert from 'node:assert/strict';
import { test } from 'node:test';

import { embedMany, wrapEmbeddingModel } from 'ai';
import { MockEmbeddingModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';

import { embeddingCacheMiddleware } from './index.ts';
import { SqliteEmbeddingCacheStore } from './sqlite.ts';

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

test('a hit from the SQLite store gives exactly the numbers that the model gave', async () => {
  // Arrange
  using database = open(':memory:');
  const numbers = [0.1, 1 / 3, -1e-300, 123456.789];
  const fake = model({ a: numbers });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new SqliteEmbeddingCacheStore({
        database,
        table: 'embedding_cache',
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
});

test('the SQLite store creates its table when it is missing', async () => {
  // Arrange
  using database = open(':memory:');
  const cached = wrapEmbeddingModel({
    model: model({ a: [1, 0] }),
    middleware: embeddingCacheMiddleware({
      store: new SqliteEmbeddingCacheStore({
        database,
        table: 'embedding_cache',
      }),
    }),
  });

  // Act
  const { embeddings } = await embedMany({ model: cached, values: ['a'] });

  // Assert
  assert.deepEqual(embeddings, [[1, 0]]);
  assert.deepEqual(
    database
      .prepare(
        `SELECT name, type, pk FROM pragma_table_info('embedding_cache')`,
      )
      .all()
      .map((column) => ({ ...column })),
    [
      { name: 'key', type: 'TEXT', pk: 1 },
      { name: 'vector', type: 'BLOB', pk: 0 },
    ],
  );
});

test('the SQLite store keeps an existing table with another column and its rows', async () => {
  // Arrange
  using database = open(':memory:');
  database.exec(`
    CREATE TABLE embedding_cache (key TEXT PRIMARY KEY, vector BLOB NOT NULL, note TEXT);
    INSERT INTO embedding_cache (key, vector, note) VALUES ('host', x'', 'kept');
  `);
  const fake = model({ a: [1, 0] });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new SqliteEmbeddingCacheStore({
        database,
        table: 'embedding_cache',
      }),
    }),
  });

  // Act
  await embedMany({ model: cached, values: ['a'] });
  const { embeddings } = await embedMany({ model: cached, values: ['a'] });

  // Assert
  assert.deepEqual(embeddings, [[1, 0]]);
  assert.equal(fake.doEmbedCalls.length, 1);
  assert.deepEqual(
    {
      ...database
        .prepare(`SELECT note FROM embedding_cache WHERE key = 'host'`)
        .get(),
    },
    { note: 'kept' },
  );
});

test('a new SQLite store on the same database reads the entries of an earlier one', async () => {
  // Arrange
  using database = open(':memory:');
  await embedMany({
    model: wrapEmbeddingModel({
      model: model({ a: [0.1, 0.2] }),
      middleware: embeddingCacheMiddleware({
        store: new SqliteEmbeddingCacheStore({
          database,
          table: 'embedding_cache',
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
        store: new SqliteEmbeddingCacheStore({
          database,
          table: 'embedding_cache',
        }),
      }),
    }),
    values: ['a'],
  });

  // Assert
  assert.deepEqual(embeddings, [[0.1, 0.2]]);
  assert.equal(later.doEmbedCalls.length, 0);
});

test('a table name that is not an identifier is refused before it reaches the SQL', () => {
  // Arrange
  using database = open(':memory:');

  // Act
  const create = () =>
    new SqliteEmbeddingCacheStore({
      database,
      table: 'embedding_cache; DROP TABLE users',
    });

  // Assert
  assert.throws(
    create,
    (error) => Error.isError(error) && error instanceof TypeError,
  );
});
