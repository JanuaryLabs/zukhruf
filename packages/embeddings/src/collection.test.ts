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

  test('the neighbour graph gives each document of the range exactly what nearest gives it, also for equal similarities and at the window edges', async () => {
    using database = new DatabaseSync(':memory:');
    // Equal vectors give equal similarities. The hours put documents exactly
    // on the edges of the window of 2 days and one minute outside them.
    const texts = {
      east: [1, 0],
      north: [0, 1],
      diagonal: [1, 1],
      near: [3, 1],
      far: [-1, 2],
    };
    const collection = new Collection({ database, model: model(texts) });
    const documents = [
      ['d01', 'east', 10, 12, 0],
      ['d02', 'east', 12, 12, 0],
      ['d03', 'diagonal', 8, 12, 0],
      ['d04', 'near', 8, 11, 59],
      ['d05', 'diagonal', 14, 12, 0],
      ['d06', 'north', 14, 12, 1],
      ['d07', 'far', 11, 0, 0],
      ['d08', 'east', 10, 12, 0],
      ['d09', 'near', 9, 6, 0],
      ['d10', 'diagonal', 13, 18, 0],
    ] as const;
    await collection.upsert(
      documents.map(([id, text, date, hour, minute]) => ({
        id,
        text,
        publishedAt: new Date(Date.UTC(2026, 9, date, hour, minute)),
      })),
    );

    const graph = collection.neighbourGraph({
      from: new Date(Date.UTC(2026, 9, 8)),
      to: new Date(Date.UTC(2026, 9, 15)),
      k: 3,
      withinDays: 2,
    });

    assert.deepEqual(
      new Map(graph),
      new Map(
        documents
          .map(([id]) => id)
          .toSorted()
          .map((id) => [id, collection.nearest(id, { k: 3, withinDays: 2 })]),
      ),
    );
  });

  test('a document outside the range of the neighbour graph has no entry, but is a neighbour of the documents in the range', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({
        before: [1, 0.2],
        first: [1, 0],
        last: [1, 0.1],
        after: [1, 0.3],
      }),
    });
    await collection.upsert([
      { id: 'before', text: 'before', publishedAt: day(7) },
      { id: 'first', text: 'first', publishedAt: day(9) },
      { id: 'last', text: 'last', publishedAt: day(11) },
      { id: 'after', text: 'after', publishedAt: day(13) },
    ]);

    // The range includes the documents exactly on its two edges.
    const graph = collection.neighbourGraph({
      from: day(9),
      to: day(11),
      k: 10,
      withinDays: 2,
    });

    assert.deepEqual(
      [...graph].map(([id, neighbours]) => [
        id,
        neighbours.map(({ id }) => id),
      ]),
      [
        ['first', ['last', 'before']],
        ['last', ['first', 'after']],
      ],
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

  test('query gives the similarity of a vector of any length to each document published in the range, the highest first and equal similarities in id order', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({
        east: [1, 0],
        north: [0, 1],
        near: [3, 1],
        diagonal: [1, 1],
      }),
    });
    await collection.upsert([
      { id: 'before', text: 'east', publishedAt: day(7) },
      { id: 'first', text: 'north', publishedAt: day(8) },
      { id: 'tie-b', text: 'diagonal', publishedAt: day(9) },
      { id: 'near', text: 'near', publishedAt: day(9) },
      { id: 'tie-a', text: 'diagonal', publishedAt: day(10) },
      {
        id: 'after',
        text: 'east',
        publishedAt: new Date(day(10).getTime() + 1),
      },
    ]);

    const matches = collection.query([4, 0], { from: day(8), to: day(10) });

    assert.deepEqual(
      matches.map(({ id }) => id),
      ['near', 'tie-a', 'tie-b', 'first'],
    );
    assert.ok(
      Math.abs((matches[0]?.similarity ?? 0) - 3 / Math.sqrt(10)) < 1e-6,
    );
    assert.ok(Math.abs((matches[1]?.similarity ?? 0) - Math.SQRT1_2) < 1e-6);
    assert.equal(matches[1]?.similarity, matches[2]?.similarity);
    assert.ok(Math.abs(matches[3]?.similarity ?? 1) < 1e-6);
  });

  test('a query vector of another dimension is a DimensionMismatchError, and an empty collection gives no match', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [1, 0] }),
    });
    const range = { from: day(1), to: day(30) };
    const empty = collection.query([1, 0, 0], range);
    await collection.upsert([{ id: 'a', text: 'a', publishedAt: day(1) }]);

    assert.deepEqual(empty, []);
    assert.throws(
      () => collection.query([1, 0, 0], range),
      (error) =>
        error instanceof DimensionMismatchError &&
        error.expected === 2 &&
        error.actual === 3,
    );
  });

  test('fetch gives the stored unit vector of each id in the order of the ids, and one unknown id fails the call', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [3, 4], b: [0, 2] }),
    });
    await collection.upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(2) },
    ]);

    const vectors = collection.fetch(['b', 'a']);

    assert.deepEqual(
      [...vectors].map(([id, vector]) => [id, [...vector]]),
      [
        ['b', [0, 1]],
        ['a', [Math.fround(0.6), Math.fround(0.8)]],
      ],
    );
    assert.throws(
      () => collection.fetch(['a', 'missing']),
      (error) =>
        error instanceof UnknownDocumentError && error.id === 'missing',
    );
  });

  test('a vector that fetch gives is a copy, so a change to it does not change the stored vector', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [1, 0], b: [1, 0] }),
    });
    await collection.upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(1) },
    ]);

    collection.fetch(['a']).get('a')?.fill(0);

    assert.ok(Math.abs(collection.similarity('a', 'b') - 1) < 1e-6);
  });

  test('delete removes the documents from every search and from the count, and a delete of an unknown or deleted id does nothing', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [1, 0], b: [1, 1], c: [0, 1] }),
    });
    await collection.upsert(
      ['a', 'b', 'c'].map((id) => ({ id, text: id, publishedAt: day(1) })),
    );

    collection.delete(['b', 'missing']);
    collection.delete(['b']);

    assert.equal(collection.count(), 2);
    assert.deepEqual(
      collection.nearest('a', { k: 10, withinDays: 1 }).map(({ id }) => id),
      ['c'],
    );
    assert.deepEqual(
      collection
        .query([1, 0], { from: day(1), to: day(1) })
        .map(({ id }) => id),
      ['a', 'c'],
    );
    assert.throws(() => collection.fetch(['b']), UnknownDocumentError);
  });

  test('an upsert after a delete embeds the text again', async () => {
    using database = new DatabaseSync(':memory:');
    const fake = model({ a: [1, 0] });
    const collection = new Collection({ database, model: fake });
    await collection.upsert([{ id: 'a', text: 'a', publishedAt: day(1) }]);
    collection.delete(['a']);

    await collection.upsert([{ id: 'a', text: 'a', publishedAt: day(1) }]);

    assert.deepEqual(embedded(fake), ['a', 'a']);
    assert.equal(collection.count(), 1);
  });

  test('count gives the number of stored documents, and an upsert of a stored id does not add one', async () => {
    using database = new DatabaseSync(':memory:');
    const collection = new Collection({
      database,
      model: model({ a: [1, 0], b: [0, 1], new: [1, 1] }),
    });
    const empty = collection.count();

    await collection.upsert([
      { id: 'a', text: 'a', publishedAt: day(1) },
      { id: 'b', text: 'b', publishedAt: day(1) },
    ]);
    await collection.upsert([{ id: 'a', text: 'new', publishedAt: day(2) }]);

    assert.equal(empty, 0);
    assert.equal(collection.count(), 2);
  });
});
