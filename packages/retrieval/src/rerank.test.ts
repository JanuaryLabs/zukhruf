import assert from 'node:assert/strict';

import type { RerankingModel } from 'ai';

import { test } from '@zukhruf/testing/node';

import { Rerank } from './index.ts';

type Call = {
  readonly documents: readonly unknown[];
  readonly query: string;
  readonly topN: number | undefined;
};

// A reranking model cannot run in CI. This one gives the relevance that the
// test names for each text, best first, cut at topN, as a provider does, and
// records each call.
const reranker = (
  relevance: Readonly<Record<string, number>>,
  calls: Call[] = [],
): RerankingModel => ({
  specificationVersion: 'v4',
  provider: 'test',
  modelId: 'rerank-mini',
  async doRerank({ documents, query, topN }) {
    calls.push({ documents: documents.values, query, topN });
    return {
      ranking: documents.values
        .map((text, index) => {
          const relevanceScore =
            typeof text === 'string' ? relevance[text] : undefined;
          if (relevanceScore === undefined) {
            throw new Error(`The test names no relevance for ${String(text)}`);
          }
          return { index, relevanceScore };
        })
        .toSorted((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, topN),
    };
  },
});

const passages = [
  { text: 'alpha', score: 0.9, vector: [1, 0] },
  { text: 'beta', score: 0.5 },
  { text: 'gamma', score: 0.1 },
].map(({ text, score, vector }) => ({
  passage: {
    id: text,
    text,
    source: 'guide',
    seq: 0,
    start: 0,
    end: text.length,
    metadata: {},
  },
  score,
  ...(vector === undefined ? {} : { vector }),
}));

const relevance = { alpha: 0.2, beta: 0.8, gamma: 0.5 };

test('each passage gets the relevance that the reranking model gives it as its score, best first, and keeps its vector', async () => {
  // Arrange
  const calls: Call[] = [];
  const rerank = new Rerank({ model: reranker(relevance, calls) });

  // Act
  const results = await rerank.postprocess(passages, 'rotate a key');

  // Assert: the model ranks beta 0.8, gamma 0.5, alpha 0.2, and every
  // passage, since no topN is given.
  assert.deepEqual(
    results.map(({ passage, score, vector }) => [passage.id, score, vector]),
    [
      ['beta', 0.8, undefined],
      ['gamma', 0.5, undefined],
      ['alpha', 0.2, [1, 0]],
    ],
  );
  assert.deepEqual(calls, [
    {
      documents: ['alpha', 'beta', 'gamma'],
      query: 'rotate a key',
      topN: undefined,
    },
  ]);
});

test('topN reaches the reranking model, and a passage that the model leaves out is dropped', async () => {
  // Arrange
  const calls: Call[] = [];
  const rerank = new Rerank({ model: reranker(relevance, calls), topN: 2 });

  // Act
  const results = await rerank.postprocess(passages, 'rotate a key');

  // Assert
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['beta', 0.8],
      ['gamma', 0.5],
    ],
  );
  assert.deepEqual(
    calls.map(({ topN }) => topN),
    [2],
  );
});

test('an empty list gives no passages and makes no call to the reranking model', async () => {
  // Arrange
  const calls: Call[] = [];
  const rerank = new Rerank({ model: reranker(relevance, calls) });

  // Act
  const results = await rerank.postprocess([], 'rotate a key');

  // Assert
  assert.deepEqual(results, []);
  assert.deepEqual(calls, []);
});

test('an error of the reranking model reaches the caller as it is', async () => {
  // Arrange
  const failure = new Error('the reranking service is down');
  const rerank = new Rerank({
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'rerank-down',
      doRerank: async () => {
        throw failure;
      },
    },
  });

  // Act and Assert
  await assert.rejects(
    rerank.postprocess(passages, 'rotate a key'),
    (error) => error === failure,
  );
});

test('a list of order only comes back with a score on every passage: the relevance that the reranking model gives it, best first', async () => {
  // Arrange
  const rerank = new Rerank({ model: reranker(relevance) });
  const ordered = ['alpha', 'beta', 'gamma'].map((text) => ({
    passage: { id: text, text, metadata: {} },
  }));

  // Act
  const results = await rerank.postprocess(ordered, 'rotate a key');

  // Assert
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['beta', 0.8],
      ['gamma', 0.5],
      ['alpha', 0.2],
    ],
  );
});

test('an aborted signal rejects with its reason and makes no call to the reranking model, which ignores its signal', async () => {
  // Arrange
  const calls: Call[] = [];
  const rerank = new Rerank({ model: reranker(relevance, calls) });
  const reason = new Error('the caller left');

  // Act
  const outcome = await rerank
    .postprocess(passages, 'rotate a key', {
      signal: AbortSignal.abort(reason),
    })
    .then(
      () => 'answered',
      (rejection: unknown) => rejection,
    );

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(calls, []);
});

void test.each(
  [
    [Number.NaN, 'beta'],
    [Number.POSITIVE_INFINITY, 'alpha'],
    [Number.NEGATIVE_INFINITY, 'gamma'],
  ] as const,
  ([score, broken]) =>
    test(`a Rerank refuses a relevance of ${score} that its reranking model gives a passage, with a TypeError that names the passage, where it sorted by it and passed it on (#5700)`, async () => {
      // Arrange
      const rerank = new Rerank({
        model: reranker({ ...relevance, [broken]: score }),
      });

      // Act and Assert
      await assert.rejects(rerank.postprocess(passages, 'rotate a key'), {
        name: 'TypeError',
        message: `Rerank reads scores, and the passage ${broken} has the score ${score}: a score is a finite number`,
      });
    }),
);
