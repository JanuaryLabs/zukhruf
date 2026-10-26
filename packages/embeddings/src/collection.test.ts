import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Collection,
  DimensionMismatchError,
  UnknownDocumentError,
} from './index.ts';

// A real embedding model cannot run in CI. The AI SDK's own mock model stands
// in for it: it gives the vector that the test names for each text, and
// fails on a text the test did not name.
function model(
  vectors: Record<string, readonly number[]>,
  identity: { provider?: string; modelId?: string } = {},
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: identity.provider ?? 'test-provider',
    modelId: identity.modelId ?? 'test-model',
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

function embedded(fake: MockEmbeddingModelV4): string[] {
  return fake.doEmbedCalls.flatMap(({ values }) => values);
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 9, n));
}

describe('Collection', () => {
  test('an upsert whose vectors have another dimension fails and stores none of its documents', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [1, 0], b: [1, 0, 0], c: [0, 1] }),
    });
    await collection.upsert([{ id: 'a', text: 'a', publishedAt: day(1) }]);

    await assert.rejects(
      collection.upsert([
        { id: 'b', text: 'b', publishedAt: day(1) },
        { id: 'c', text: 'c', publishedAt: day(1) },
      ]),
      (error) =>
        error instanceof DimensionMismatchError &&
        error.expected === 2 &&
        error.actual === 3,
    );

    assert.throws(() => collection.similarity('a', 'c'), UnknownDocumentError);
    assert.deepEqual(collection.nearest('a', { k: 10, withinDays: 7 }), []);
  });

  test('an upsert that replaces only some documents cannot change their dimension', async () => {
    using database = new DatabaseSync(':memory:');
    await new Collection({
      database,
      model: model({ a: [1, 0], b: [1, 0] }, { modelId: 'small' }),
    }).upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(1) },
    ]);
    const collection = new Collection({
      database,
      model: model({ a: [0, 1, 0] }, { modelId: 'large' }),
    });

    await assert.rejects(
      collection.upsert([{ id: 'a', text: 'a', publishedAt: day(1) }]),
      (error) =>
        error instanceof DimensionMismatchError &&
        error.expected === 2 &&
        error.actual === 3,
    );

    assert.ok(Math.abs(collection.similarity('a', 'b') - 1) < 1e-6);
  });

  test('an upsert fails and stores none of its documents when the model gives a vector of length zero', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [1, 0], zero: [0, 0] }),
    });

    await assert.rejects(
      collection.upsert([
        { id: 'a', text: 'a', publishedAt: day(1) },
        { id: 'zero', text: 'zero', publishedAt: day(1) },
      ]),
      RangeError,
    );

    assert.throws(
      () => collection.nearest('a', { k: 1, withinDays: 1 }),
      UnknownDocumentError,
    );
  });

  test('an upsert that replaces every document may change the dimension', async () => {
    using database = new DatabaseSync(':memory:');
    await new Collection({
      database,
      model: model({ a: [1, 0], b: [0, 1] }, { modelId: 'small' }),
    }).upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(1) },
    ]);
    const collection = new Collection({
      database,
      model: model({ a: [1, 0, 0], b: [1, 1, 0] }, { modelId: 'large' }),
    });

    await collection.upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(1) },
    ]);

    assert.ok(Math.abs(collection.similarity('a', 'b') - Math.SQRT1_2) < 1e-6);
  });

  test('an unknown id is an UnknownDocumentError', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({ database, model: model({ a: [1] }) });
    await collection.upsert([{ id: 'a', text: 'a', publishedAt: day(1) }]);

    assert.throws(
      () => collection.nearest('missing', { k: 1, withinDays: 1 }),
      (error) =>
        error instanceof UnknownDocumentError && error.id === 'missing',
    );
    assert.throws(
      () => collection.similarity('a', 'missing'),
      (error) =>
        error instanceof UnknownDocumentError && error.id === 'missing',
    );
  });

  test('nearest gives the k most similar other documents, and equal similarities in id order', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({
        query: [1, 0],
        far: [0, 1],
        near: [3, 1],
        'tie-b': [1, 1],
        'tie-a': [2, 2],
      }),
    });
    await collection.upsert(
      ['far', 'tie-b', 'query', 'near', 'tie-a'].map((id) => ({
        id,
        text: id,
        publishedAt: day(10),
      })),
    );

    const neighbours = collection.nearest('query', { k: 3, withinDays: 0 });

    assert.deepEqual(
      neighbours.map(({ id }) => id),
      ['near', 'tie-a', 'tie-b'],
    );
    assert.ok(
      Math.abs((neighbours[0]?.similarity ?? 0) - 3 / Math.sqrt(10)) < 1e-6,
    );
    assert.equal(neighbours[1]?.similarity, neighbours[2]?.similarity);
  });

  test('nearest compares only documents published at most withinDays before or after the document', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ query: [1, 0], doc: [1, 0] }),
    });
    const at = (date: Date, id: string) => ({
      id,
      text: id === 'query' ? 'query' : 'doc',
      publishedAt: date,
    });
    await collection.upsert([
      at(new Date(Date.UTC(2026, 9, 10, 12)), 'query'),
      at(new Date(Date.UTC(2026, 9, 7, 12)), 'edge-before'),
      at(new Date(Date.UTC(2026, 9, 13, 12)), 'edge-after'),
      at(new Date(Date.UTC(2026, 9, 7, 11, 59)), 'out-before'),
      at(new Date(Date.UTC(2026, 9, 13, 12, 1)), 'out-after'),
    ]);

    assert.deepEqual(
      collection.nearest('query', { k: 10, withinDays: 3 }).map(({ id }) => id),
      ['edge-after', 'edge-before'],
    );
  });

  test('an upsert after the publish date changed moves the document in the window without embedding it again', async () => {
    using database = new DatabaseSync(':memory:');
    const fake = model({ query: [1, 0], doc: [1, 0] });
    const collection = new Collection({ database, model: fake });
    await collection.upsert([
      { id: 'query', text: 'query', publishedAt: day(10) },
      { id: 'doc', text: 'doc', publishedAt: day(1) },
    ]);

    await collection.upsert([{ id: 'doc', text: 'doc', publishedAt: day(9) }]);

    assert.deepEqual(
      collection.nearest('query', { k: 10, withinDays: 1 }).map(({ id }) => id),
      ['doc'],
    );
    assert.deepEqual(embedded(fake), ['query', 'doc']);
  });

  test('an unchanged text is not embedded again, also by a new collection on the same database file', async () => {
    await using folder = await new TemporaryFiles().directory('embeddings-');
    const path = join(folder.path, 'collection.sqlite');
    const vectors = { a: [1, 0], b: [0, 1], c: [1, 1] };
    {
      using database = new DatabaseSync(path);
      await new Collection({ database, model: model(vectors) }).upsert([
        { id: 'a', text: 'a', publishedAt: day(1) },
        { id: 'b', text: 'b', publishedAt: day(1) },
      ]);
    }
    using database = new DatabaseSync(path);
    const fake = model(vectors);
    const collection = new Collection({ database, model: fake });

    await collection.upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(1) },
      { id: 'c', text: 'c', publishedAt: day(1) },
    ]);

    assert.deepEqual(embedded(fake), ['c']);
    assert.equal(collection.similarity('a', 'b'), 0);
  });

  test('a changed text is embedded again, and the search uses its new vector', async () => {
    using database = new DatabaseSync(':memory:');
    const fake = model({ query: [1, 0], old: [0, 1], new: [1, 0] });
    const collection = new Collection({ database, model: fake });
    await collection.upsert([
      { id: 'query', text: 'query', publishedAt: day(1) },
      { id: 'doc', text: 'old', publishedAt: day(1) },
    ]);

    await collection.upsert([
      { id: 'query', text: 'query', publishedAt: day(1) },
      { id: 'doc', text: 'new', publishedAt: day(1) },
    ]);

    assert.deepEqual(embedded(fake), ['query', 'old', 'new']);
    assert.ok(Math.abs(collection.similarity('query', 'doc') - 1) < 1e-6);
  });

  test('a new provider or a new model id embeds an unchanged text again', async () => {
    using database = new DatabaseSync(':memory:');
    const documents = [
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(1) },
    ];
    await new Collection({
      database,
      model: model({ a: [1, 0], b: [0, 1] }, { provider: 'p1', modelId: 'm1' }),
    }).upsert(documents);
    const provider = model(
      { a: [1, 0], b: [1, 1] },
      { provider: 'p2', modelId: 'm1' },
    );
    const modelId = model(
      { a: [1, 0], b: [1, 0] },
      { provider: 'p2', modelId: 'm2' },
    );

    await new Collection({ database, model: provider }).upsert(documents);
    const afterProvider = new Collection({
      database,
      model: provider,
    }).similarity('a', 'b');
    const collection = new Collection({ database, model: modelId });
    await collection.upsert(documents);

    assert.deepEqual(embedded(provider), ['a', 'b']);
    assert.ok(Math.abs(afterProvider - Math.SQRT1_2) < 1e-6);
    assert.deepEqual(embedded(modelId), ['a', 'b']);
    assert.ok(Math.abs(collection.similarity('a', 'b') - 1) < 1e-6);
  });

  test('similarity is the cosine of the two documents, whatever the length of their vectors', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [3, 4], b: [40, 30] }),
    });
    await collection.upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(20) },
    ]);

    assert.ok(Math.abs(collection.similarity('a', 'b') - 0.96) < 1e-6);
    assert.ok(Math.abs(collection.similarity('b', 'a') - 0.96) < 1e-6);
  });
});
