import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection, UnknownDocumentError, VectorSearch } from './index.ts';

function day(n: number): Date {
  return new Date(Date.UTC(2026, 9, n));
}

// A unit vector as a BLOB of float32 values in the byte order of the
// platform, which is what a program that writes a vector table stores.
function unitBlob(values: readonly number[]): Uint8Array {
  const length = Math.hypot(...values);
  return new Uint8Array(
    Float32Array.from(values, (value) => value / length).buffer,
  );
}

describe('VectorSearch', () => {
  test('a search over a plain table and over a view that renames columns gives the same neighbours as a collection with the same vectors', async () => {
    // Equal similarities (b, c, e) test the id order; f and g sit on and
    // past the edge of the 7-day window of a.
    const documents = [
      { id: 'a', vector: [1, 0], publishedAt: day(8) },
      { id: 'c', vector: [0.6, 0.8], publishedAt: day(9) },
      { id: 'b', vector: [0.6, 0.8], publishedAt: day(10) },
      { id: 'e', vector: [0.6, -0.8], publishedAt: day(11) },
      { id: 'd', vector: [0, 1], publishedAt: day(12) },
      { id: 'f', vector: [0.8, 0.6], publishedAt: day(15) },
      { id: 'g', vector: [1, 0.1], publishedAt: day(16) },
    ];
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      // A real embedding model cannot run in CI. The AI SDK's own mock model
      // gives the vector of each document, keyed by its text.
      model: new MockEmbeddingModelV4({
        provider: 'test-provider',
        modelId: 'test-model',
        doEmbed: async ({ values }) => ({
          embeddings: values.map((text) => [
            ...(documents.find(({ id }) => id === text)?.vector ?? []),
          ]),
          warnings: [],
        }),
      }),
    });
    await collection.upsert(
      documents.map(({ id, publishedAt }) => ({ id, text: id, publishedAt })),
    );
    database.exec(
      'CREATE TABLE listing_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, published_at INTEGER NOT NULL) STRICT',
    );
    database.exec(
      'CREATE TABLE listing (key TEXT PRIMARY KEY, embedding BLOB NOT NULL, created INTEGER NOT NULL) STRICT',
    );
    database.exec(
      'CREATE VIEW "listing ""vectors""" AS SELECT key AS id, embedding AS vector, created AS published_at FROM listing',
    );
    for (const { id, vector, publishedAt } of documents) {
      database
        .prepare('INSERT INTO listing_vectors VALUES (?, ?, ?)')
        .run(id, unitBlob(vector), publishedAt.getTime());
      database
        .prepare('INSERT INTO listing VALUES (?, ?, ?)')
        .run(id, unitBlob(vector), publishedAt.getTime());
    }

    const searches = [
      new VectorSearch({ database, table: 'listing_vectors' }),
      new VectorSearch({ database, table: 'listing "vectors"' }),
    ];

    const graph = (search: Collection | VectorSearch) => [
      ...search.neighbourGraph({
        from: day(8),
        to: day(12),
        k: 3,
        withinDays: 7,
      }),
    ];
    assert.deepEqual(collection.nearest('a', { k: 4, withinDays: 7 }), [
      { id: 'f', similarity: collection.similarity('a', 'f') },
      { id: 'b', similarity: collection.similarity('a', 'b') },
      { id: 'c', similarity: collection.similarity('a', 'c') },
      { id: 'e', similarity: collection.similarity('a', 'e') },
    ]);
    for (const search of searches) {
      for (const { id } of documents)
        assert.deepEqual(
          search.nearest(id, { k: 4, withinDays: 7 }),
          collection.nearest(id, { k: 4, withinDays: 7 }),
        );
      assert.deepEqual(graph(search), graph(collection));
      assert.equal(
        search.similarity('a', 'f'),
        collection.similarity('a', 'f'),
      );
    }
  });

  test('an id that the vector table does not contain is an UnknownDocumentError', () => {
    using database = new DatabaseSync(':memory:');
    database.exec(
      'CREATE TABLE listing_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, published_at INTEGER NOT NULL) STRICT',
    );
    database
      .prepare('INSERT INTO listing_vectors VALUES (?, ?, ?)')
      .run('a', unitBlob([1, 0]), day(1).getTime());
    const search = new VectorSearch({ database, table: 'listing_vectors' });

    assert.throws(
      () => search.nearest('missing', { k: 1, withinDays: 1 }),
      (error) =>
        error instanceof UnknownDocumentError && error.id === 'missing',
    );
    assert.throws(
      () => search.similarity('a', 'missing'),
      UnknownDocumentError,
    );
  });
});
