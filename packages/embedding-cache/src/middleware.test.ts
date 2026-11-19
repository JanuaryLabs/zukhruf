import assert from 'node:assert/strict';
import { test } from 'node:test';

import { embedMany, wrapEmbeddingModel } from 'ai';
import { MockEmbeddingModelV4 } from 'ai/test';

import {
  MemoryEmbeddingCacheStore,
  embeddingCacheMiddleware,
} from './index.ts';

// A real embedding model cannot run in CI. The AI SDK's own mock model stands
// in for it at the provider boundary: it gives the vector that the test names
// for each text, fails on a text the test did not name, and records each call.
function model(
  vectors: Record<string, readonly number[]>,
  identity: { provider?: string; modelId?: string } = {},
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: identity.provider ?? 'test-provider',
    modelId: identity.modelId ?? 'test-model',
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((text) => {
        const vector = vectors[text];
        if (vector === undefined)
          throw new Error(`The test names no vector for ${text}`);
        return [...vector];
      }),
      usage: { tokens: values.length * 10 },
      warnings: [],
    }),
  });
}

function embedded(fake: MockEmbeddingModelV4): string[][] {
  return fake.doEmbedCalls.map(({ values }) => values);
}

test('a call whose texts all hit makes no model call', async () => {
  // Arrange
  const fake = model({ a: [1, 0], b: [0, 1] });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });
  await embedMany({ model: cached, values: ['a', 'b'] });

  // Act
  const { embeddings } = await embedMany({ model: cached, values: ['b', 'a'] });

  // Assert
  assert.deepEqual(embedded(fake), [['a', 'b']]);
  assert.deepEqual(embeddings, [
    [0, 1],
    [1, 0],
  ]);
});

test('a partial hit calls the model once with only the misses, each distinct miss once', async () => {
  // Arrange
  const fake = model({ a: [1, 0], b: [0, 1], c: [1, 1], d: [2, 2] });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });
  await embedMany({ model: cached, values: ['a', 'b'] });

  // Act
  await embedMany({ model: cached, values: ['a', 'c', 'b', 'c', 'd'] });

  // Assert
  assert.deepEqual(embedded(fake), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('the answer follows the order of the texts, duplicates included', async () => {
  // Arrange
  const fake = model({ a: [1, 0], b: [0, 1], c: [1, 1] });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });
  await embedMany({ model: cached, values: ['b'] });

  // Act
  const { embeddings } = await embedMany({
    model: cached,
    values: ['c', 'b', 'a', 'c', 'b'],
  });

  // Assert
  assert.deepEqual(embeddings, [
    [1, 1],
    [0, 1],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
});

test('a hit from the memory store gives exactly the numbers that the model gave', async () => {
  // Arrange
  const numbers = [0.1, 1 / 3, -1e-300, 123456.789];
  const fake = model({ a: numbers });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });
  await embedMany({ model: cached, values: ['a'] });

  // Act
  const { embeddings } = await embedMany({ model: cached, values: ['a'] });

  // Assert
  assert.deepEqual(embedded(fake), [['a']]);
  assert.deepEqual(embeddings, [numbers]);
});

test('another model id, provider, provider options or dimensions is a miss', async () => {
  // Arrange
  const store = new MemoryEmbeddingCacheStore();
  const first = model({ a: [1, 0] });
  const otherModel = model({ a: [2, 0] }, { modelId: 'other-model' });
  const otherProvider = model({ a: [3, 0] }, { provider: 'other-provider' });
  const wrap = (fake: MockEmbeddingModelV4) =>
    wrapEmbeddingModel({
      model: fake,
      middleware: embeddingCacheMiddleware({ store }),
    });
  await embedMany({ model: wrap(first), values: ['a'] });

  // Act
  const byModel = await embedMany({ model: wrap(otherModel), values: ['a'] });
  const byProvider = await embedMany({
    model: wrap(otherProvider),
    values: ['a'],
  });
  const byOptions = await embedMany({
    model: wrap(first),
    values: ['a'],
    providerOptions: { 'test-provider': { prompt: 'query' } },
  });
  const byDimensions = await embedMany({
    model: wrap(first),
    values: ['a'],
    dimensions: 2,
  });

  // Assert
  assert.deepEqual(
    [byModel, byProvider, byOptions, byDimensions].map(
      ({ embeddings }) => embeddings,
    ),
    [[[2, 0]], [[3, 0]], [[1, 0]], [[1, 0]]],
  );
  assert.deepEqual(embedded(otherModel), [['a']]);
  assert.deepEqual(embedded(otherProvider), [['a']]);
  assert.deepEqual(embedded(first), [['a'], ['a'], ['a']]);
});

test('the miss call carries the abort signal, headers, provider options and dimensions of the call', async () => {
  // Arrange
  const fake = model({ a: [1, 0], b: [0, 1] });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });
  const providerOptions = { 'test-provider': { prompt: 'document' } };
  await embedMany({
    model: cached,
    values: ['a'],
    providerOptions,
    dimensions: 2,
  });
  const controller = new AbortController();

  // Act
  await embedMany({
    model: cached,
    values: ['a', 'b'],
    abortSignal: controller.signal,
    headers: { 'x-tenant': 'acme' },
    providerOptions,
    dimensions: 2,
  });

  // Assert
  const call = fake.doEmbedCalls[1];
  assert.deepEqual(call?.values, ['b']);
  assert.equal(call?.abortSignal, controller.signal);
  assert.equal(call?.headers?.['x-tenant'], 'acme');
  assert.deepEqual(call?.providerOptions, providerOptions);
  assert.equal(call?.dimensions, 2);
});

test('usage counts the tokens of the miss call only, and a full hit reports 0 tokens', async () => {
  // Arrange
  const fake = model({ a: [1, 0], b: [0, 1], c: [1, 1] });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });
  await embedMany({ model: cached, values: ['a'] });

  // Act
  const partial = await embedMany({ model: cached, values: ['a', 'b', 'c'] });
  const full = await embedMany({ model: cached, values: ['c', 'a'] });

  // Assert
  assert.deepEqual([partial.usage.tokens, full.usage.tokens], [20, 0]);
});

test('response, provider metadata and warnings come from the miss call', async () => {
  // Arrange
  const fake = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => [1, 0]),
      response: { headers: { 'x-request': values.join() }, body: { values } },
      providerMetadata: { mock: { request: values.join() } },
      warnings: [{ type: 'other', message: `embedded ${values.join()}` }],
    }),
  });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });
  await embedMany({ model: cached, values: ['a'] });

  // Act
  const { responses, providerMetadata, warnings } = await embedMany({
    model: cached,
    values: ['a', 'b'],
  });

  // Assert
  assert.deepEqual(responses, [
    { headers: { 'x-request': 'b' }, body: { values: ['b'] } },
  ]);
  assert.deepEqual(providerMetadata, { mock: { request: 'b' } });
  assert.deepEqual(warnings, [{ type: 'other', message: 'embedded b' }]);
});

test('a model error reaches the caller and stores nothing, so the next call asks the model again', async () => {
  // Arrange
  const failure = new Error('the provider is down');
  const fake = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async () => {
      if (fake.doEmbedCalls.length === 1) throw failure;
      return { embeddings: [[1, 0]], warnings: [] };
    },
  });
  const cached = wrapEmbeddingModel({
    model: fake,
    middleware: embeddingCacheMiddleware({
      store: new MemoryEmbeddingCacheStore(),
    }),
  });

  // Act
  const failed = embedMany({ model: cached, values: ['a'] });

  // Assert
  await assert.rejects(failed, (error) => error === failure);
  const { embeddings } = await embedMany({ model: cached, values: ['a'] });
  assert.deepEqual(embeddings, [[1, 0]]);
  assert.deepEqual(embedded(fake), [['a'], ['a']]);
});

test('an error of store.get reaches the caller', async () => {
  // Arrange
  const failure = new Error('the cache table is locked');
  const cached = wrapEmbeddingModel({
    model: model({ a: [1, 0] }),
    middleware: embeddingCacheMiddleware({
      store: {
        get: () => Promise.reject(failure),
        set: () => Promise.resolve(),
      },
    }),
  });

  // Act
  const call = embedMany({ model: cached, values: ['a'] });

  // Assert
  await assert.rejects(call, (error) => error === failure);
});

test('an error of store.set reaches the caller', async () => {
  // Arrange
  const failure = new Error('the disk is full');
  const cached = wrapEmbeddingModel({
    model: model({ a: [1, 0] }),
    middleware: embeddingCacheMiddleware({
      store: {
        get: () => Promise.resolve(new Map()),
        set: () => Promise.reject(failure),
      },
    }),
  });

  // Act
  const call = embedMany({ model: cached, values: ['a'] });

  // Assert
  await assert.rejects(call, (error) => error === failure);
});
