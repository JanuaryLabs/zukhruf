import assert from 'node:assert/strict';

import { test } from '@zukhruf/testing/node';

import { MaximalMarginalRelevance, VectorMissingError } from './index.ts';
import { embeddingModel } from './testing/embedding-model.ts';

// The query 'rotate a key' has the vector [4, 3, 0].
const model = (signals: (AbortSignal | undefined)[] = []) =>
  embeddingModel({ 'rotate a key': [4, 3, 0] }, { signals });

// Every vector has length 5, so a cosine is the dot product / 25.
//   relevance to the query [4, 3, 0]: a 20/25 = 0.8, b 15/25 = 0.6,
//                                     c 0, d 16/25 = 0.64
//   similarity: a-b 0, a-c 0, a-d 20/25 = 0.8, b-c 0, b-d 0, c-d 15/25 = 0.6
// The list is in the order of the scores of an earlier step (a reranker),
// which is not the order of the relevance: c, d, b, a.
const list = [
  { id: 'c', score: 0.9, vector: [0, 0, 5] },
  { id: 'd', score: 0.8, vector: [4, 0, 3] },
  { id: 'b', score: 0.7, vector: [0, 5, 0] },
  { id: 'a', score: 0.6, vector: [5, 0, 0] },
].map(({ id, score, vector }) => ({
  passage: {
    id,
    text: id,
    source: id,
    seq: 0,
    start: 0,
    end: 1,
    metadata: {},
  },
  score,
  vector,
}));

const picks = (
  results: readonly {
    readonly passage: { readonly id: string };
    readonly score?: number;
  }[],
) => results.map(({ passage, score }) => [passage.id, score]);

test('with the default lambda 0.5 each pick weighs the relevance to the query against the redundancy to the picks before it', async () => {
  // Arrange
  const mmr = new MaximalMarginalRelevance({ model: model(), topK: 3 });

  // Act
  const results = await mmr.postprocess(list, 'rotate a key');

  // Assert: 0.5 * relevance - 0.5 * redundancy
  //   pick 1: the most relevant, a (0.8)
  //   pick 2: b 0.5 * 0.6 - 0.5 * 0 = 0.3; c 0 - 0 = 0;
  //           d 0.5 * 0.64 - 0.5 * 0.8 = -0.08          -> b
  //   pick 3: c 0 - 0.5 * max(0, 0) = 0;
  //           d 0.32 - 0.5 * max(0.8, 0) = -0.08        -> c
  // The passages come in the order of the picks, with their scores.
  assert.deepEqual(picks(results), [
    ['a', 0.6],
    ['b', 0.7],
    ['c', 0.9],
  ]);
});

test('lambda 1 picks by the cosine similarity to the query vector, not by the score that the list has, and lambda 0.7 trades less relevance away', async () => {
  // Arrange
  const relevanceOnly = new MaximalMarginalRelevance({
    model: model(),
    lambda: 1,
    topK: 4,
  });
  const mostlyRelevance = new MaximalMarginalRelevance({
    model: model(),
    lambda: 0.7,
    topK: 3,
  });

  // Act
  const byRelevance = await relevanceOnly.postprocess(list, 'rotate a key');
  const weighted = await mostlyRelevance.postprocess(list, 'rotate a key');

  // Assert: lambda 1 gives a 0.8, d 0.64, b 0.6, c 0. With 0.7:
  //   pick 2: b 0.7 * 0.6 - 0.3 * 0 = 0.42; c 0;
  //           d 0.7 * 0.64 - 0.3 * 0.8 = 0.208          -> b
  //   pick 3: c 0 - 0.3 * 0 = 0; d 0.448 - 0.3 * 0.8 = 0.208 -> d
  assert.deepEqual(
    byRelevance.map(({ passage }) => passage.id),
    ['a', 'd', 'b', 'c'],
  );
  assert.deepEqual(
    weighted.map(({ passage }) => passage.id),
    ['a', 'b', 'd'],
  );
});

test('a tie goes to the passage that comes first in the list, for the first pick and for a later one', async () => {
  // Arrange
  const diversityOnly = new MaximalMarginalRelevance({
    model: model(),
    lambda: 0,
    topK: 2,
  });
  const twin = {
    passage: {
      id: 'twin',
      text: 'twin',
      source: 'twin',
      seq: 0,
      start: 0,
      end: 1,
      metadata: {},
    },
    score: 0.5,
    vector: [5, 0, 0],
  };
  const relevanceOnly = new MaximalMarginalRelevance({
    model: model(),
    lambda: 1,
    topK: 1,
  });

  // Act
  const second = await diversityOnly.postprocess(list, 'rotate a key');
  const first = await relevanceOnly.postprocess(
    [...list, twin].toReversed(),
    'rotate a key',
  );

  // Assert: with lambda 0 the second pick is - redundancy to a: b 0, c 0,
  // d -0.8, and c comes before b in the list. The twin has the vector of a,
  // so a relevance of 0.8, and comes first in the reversed list.
  assert.deepEqual(
    second.map(({ passage }) => passage.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    first.map(({ passage }) => passage.id),
    ['twin'],
  );
});

test('a topK above the length of the list gives every passage, and an empty list gives none with no model call', async () => {
  // Arrange
  const signals: (AbortSignal | undefined)[] = [];
  const mmr = new MaximalMarginalRelevance({ model: model(signals), topK: 10 });

  // Act
  const none = await mmr.postprocess([], 'rotate a key');
  const all = await mmr.postprocess(list, 'rotate a key');

  // Assert: a, b, c as with topK 3, then d, the only one left.
  assert.deepEqual(none, []);
  assert.deepEqual(
    all.map(({ passage }) => passage.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(signals.length, 1);
});

test('a passage without a vector is a VectorMissingError that names it, before the model call', async () => {
  // Arrange
  const signals: (AbortSignal | undefined)[] = [];
  const mmr = new MaximalMarginalRelevance({ model: model(signals), topK: 2 });
  const withoutVector = list.map(({ passage, score, vector }) =>
    passage.id === 'b' ? { passage, score } : { passage, score, vector },
  );

  // Act and Assert
  await assert.rejects(mmr.postprocess(withoutVector, 'rotate a key'), {
    name: 'VectorMissingError',
    passageId: 'b',
    message: 'The passage b has no vector: retrieve with includeVectors: true',
  });
  await assert.rejects(
    mmr.postprocess(withoutVector, 'rotate a key'),
    VectorMissingError,
  );
  assert.deepEqual(signals, []);
});

test('a lambda outside 0 to 1 and a topK that is not a positive integer are refused', () => {
  // Act and Assert
  for (const lambda of [-0.1, 1.1, Number.NaN]) {
    assert.throws(
      () => new MaximalMarginalRelevance({ model: model(), lambda, topK: 2 }),
      {
        name: 'RangeError',
        message: `The lambda is from 0 to 1, not ${lambda}`,
      },
    );
  }
  for (const topK of [0, 1.5]) {
    assert.throws(
      () => new MaximalMarginalRelevance({ model: model(), topK }),
      {
        name: 'RangeError',
        message: `The topK is a positive integer, not ${topK}`,
      },
    );
  }
});

test('the abort signal of the call reaches the embedding model', async () => {
  // Arrange
  const signals: (AbortSignal | undefined)[] = [];
  const mmr = new MaximalMarginalRelevance({ model: model(signals), topK: 1 });
  const controller = new AbortController();

  // Act
  await mmr.postprocess(list, 'rotate a key', {
    signal: controller.signal,
  });

  // Assert
  assert.deepEqual(signals, [controller.signal]);
});

test('an aborted signal rejects with its reason and makes no call to the embedding model, which ignores its signal', async () => {
  // Arrange
  const signals: (AbortSignal | undefined)[] = [];
  const mmr = new MaximalMarginalRelevance({ model: model(signals), topK: 1 });
  const reason = new Error('the caller left');

  // Act
  const outcome = await mmr
    .postprocess(list, 'rotate a key', { signal: AbortSignal.abort(reason) })
    .then(
      () => 'answered',
      (rejection: unknown) => rejection,
    );

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(signals, []);
});

void test.each(
  [
    ['an empty string', ''],
    ['a string of white space', ' \t\n'],
  ] as const,
  ([name, query]) =>
    test(`${name} as the information need is a RangeError before the embedding model is called, as EmbeddingRerankRetriever refuses it`, async () => {
      // Arrange
      const embedding = model();
      const mmr = new MaximalMarginalRelevance({ model: embedding, topK: 2 });

      // Act and Assert
      await assert.rejects(mmr.postprocess(list, query), {
        name: 'RangeError',
        message: `The query of a query bundle holds no word: got ${JSON.stringify(query)}`,
      });
      assert.deepEqual(embedding.doEmbedCalls, []);
    }),
);
