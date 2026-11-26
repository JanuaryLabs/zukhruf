import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { RerankingModel } from 'ai';

import { test } from '@zukhruf/testing/node';

import {
  RerankRetriever,
  type RetrieveOptions,
  RetrieverUnavailableError,
  type StoredPassage,
} from './index.ts';
import { LiveRetriever } from './testing/live-retriever.ts';
import {
  type EntrezQueryBundle,
  RecordingRetriever,
} from './testing/recording-retriever.ts';
import { settledThisTurn } from './testing/settled-this-turn.ts';

type Call = {
  readonly documents: readonly unknown[];
  readonly query: string;
  readonly topN: number | undefined;
};

// A reranking model cannot run in CI. This one gives the relevance that the
// test names for each text, best first, cut at topN, as a provider does, and
// records each call and its abort signal.
const reranker = (
  relevance: Readonly<Record<string, number>>,
  calls: Call[] = [],
  signals: (AbortSignal | undefined)[] = [],
): RerankingModel => ({
  specificationVersion: 'v4',
  provider: 'test',
  modelId: 'rerank-mini',
  async doRerank({ documents, query, topN, abortSignal }) {
    calls.push({ documents: documents.values, query, topN });
    signals.push(abortSignal);
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

// A host retriever that gives the scored passages above, in their order.
const search = {
  retrieve: async () => ({
    passages,
    failures: new Map<string, RetrieverUnavailableError>(),
  }),
};

const relevance = { alpha: 0.2, beta: 0.8, gamma: 0.5 };

test('an aborted signal rejects with its reason, and starts no search and no call to the reranking model', async () => {
  // Arrange
  const calls: Call[] = [];
  const source = new RecordingRetriever(['alpha', 'beta', 'gamma']);
  const rerank = new RerankRetriever({
    retriever: source,
    model: reranker(relevance, calls),
  });
  const reason = new Error('the caller left');

  // Act
  const outcome = await settledThisTurn(
    rerank.retrieve('rotate a key', { signal: AbortSignal.abort(reason) }),
  );

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(source.queries, []);
  assert.deepEqual(calls, []);
});

test("the caller's abort rejects the call at once with the signal's reason, while its retriever ignores its signal and never settles", async () => {
  // Arrange
  const started = Promise.withResolvers<void>();
  const rerank = new RerankRetriever({
    retriever: {
      retrieve: () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
    },
    model: reranker(relevance),
  });
  const controller = new AbortController();
  const reason = new Error('the caller left');

  // Act
  const call = rerank.retrieve('rotate a key', { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  const outcome = await settledThisTurn(call);

  // Assert
  assert.equal(outcome, reason);
});

test('an abort while its retriever runs makes no call to the reranking model, even when the retriever ignores its signal and answers', async () => {
  // Arrange
  const calls: Call[] = [];
  const controller = new AbortController();
  const reason = new Error('the caller left');
  const rerank = new RerankRetriever({
    retriever: {
      retrieve: async () => {
        controller.abort(reason);
        return search.retrieve();
      },
    },
    model: reranker(relevance, calls),
  });

  // Act
  const outcome = await settledThisTurn(
    rerank.retrieve('rotate a key', { signal: controller.signal }),
  );
  await nextTurn();

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(calls, []);
});

test('an error of the reranking model reaches the caller as it is', async () => {
  // Arrange
  const failure = new Error('the reranking service is down');
  const rerank = new RerankRetriever({
    retriever: search,
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
    rerank.retrieve('rotate a key'),
    (error) => error === failure,
  );
});

void test.each(
  [
    [Number.NaN, 'beta'],
    [Number.POSITIVE_INFINITY, 'alpha'],
    [Number.NEGATIVE_INFINITY, 'gamma'],
  ] as const,
  ([score, broken]) =>
    test(`a RerankRetriever refuses a relevance of ${score} that its reranking model gives a passage, with a TypeError that names the passage, where it sorted by it and passed it on (#5700)`, async () => {
      // Arrange
      const rerank = new RerankRetriever({
        retriever: search,
        model: reranker({ ...relevance, [broken]: score }),
      });

      // Act and Assert
      await assert.rejects(rerank.retrieve('rotate a key'), {
        name: 'TypeError',
        message: `RerankRetriever reads scores, and the passage ${broken} has the score ${score}: a score is a finite number`,
      });
    }),
);

void test.each(
  [[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]] as const,
  ([topN]) =>
    test(`a topN of ${topN} is a RangeError when the RerankRetriever is made, where it reached the AI SDK`, () => {
      assert.throws(
        () =>
          new RerankRetriever({
            retriever: search,
            model: reranker(relevance),
            topN,
          }),
        {
          name: 'RangeError',
          message: `The topN is a positive integer, not ${topN}`,
        },
      );
    }),
);

void test.each(
  [
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
  ] as const,
  ([scoreThreshold]) =>
    test(`a scoreThreshold of ${scoreThreshold} is a RangeError when the RerankRetriever is made, as a threshold that is not finite cuts no list the way the caller meant (#5734)`, () => {
      assert.throws(
        () =>
          new RerankRetriever({
            retriever: search,
            model: reranker(relevance),
            scoreThreshold,
          }),
        {
          name: 'RangeError',
          message: `The scoreThreshold is a finite number, not ${scoreThreshold}`,
        },
      );
    }),
);

test('each passage gets the relevance that the reranking model gives it as its score, best first, and keeps its vector', async () => {
  // Arrange
  const calls: Call[] = [];
  const rerank = new RerankRetriever({
    retriever: search,
    model: reranker(relevance, calls),
  });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

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

test('the reranking model gets the text of each passage, not its id', async () => {
  // Arrange
  const calls: Call[] = [];
  const rerank = new RerankRetriever({
    retriever: {
      retrieve: async () => ({
        passages: [{ passage: { id: 'p1', text: 'beta', metadata: {} } }],
        failures: new Map<string, RetrieverUnavailableError>(),
      }),
    },
    model: reranker(relevance, calls),
  });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

  // Assert
  assert.deepEqual(
    calls.map(({ documents }) => documents),
    [['beta']],
  );
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [['p1', 0.8]],
  );
});

test('topN reaches the reranking model, and a passage that the model leaves out is dropped', async () => {
  // Arrange
  const calls: Call[] = [];
  const rerank = new RerankRetriever({
    retriever: search,
    model: reranker(relevance, calls),
    topN: 2,
  });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

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
  const rerank = new RerankRetriever({
    retriever: {
      retrieve: async () => ({ passages: [], failures: new Map() }),
    },
    model: reranker(relevance, calls),
  });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

  // Assert
  assert.deepEqual(results, []);
  assert.deepEqual(calls, []);
});

test('a list of order only comes back with a score on every passage, the relevance that the reranking model gives it, best first, and the failures of its retriever pass up unchanged', async () => {
  // Arrange: a live source that gives an order only and names one child
  // that was unavailable.
  const unavailable = new RetrieverUnavailableError('HTTP 503');
  const rerank = new RerankRetriever({
    retriever: new LiveRetriever(
      ['alpha', 'beta', 'gamma'],
      new Map([['news', unavailable]]),
    ),
    model: reranker(relevance),
  });

  // Act
  const result = await rerank.retrieve('rotate a key');

  // Assert
  assert.deepEqual(
    result.passages.map(({ passage, score }) => [passage.id, score]),
    [
      ['beta', 0.8],
      ['gamma', 0.5],
      ['alpha', 0.2],
    ],
  );
  assert.deepEqual([...result.failures], [['news', unavailable]]);
  assert.equal(result.failures.get('news'), unavailable);
});

test('a retriever that needs its own field gets the query bundle unchanged, while the reranking model gets the information need', async () => {
  // Arrange
  const calls: Call[] = [];
  const source = new RecordingRetriever<EntrezQueryBundle>(['alpha', 'gamma']);
  const rerank = new RerankRetriever({
    retriever: source,
    model: reranker(relevance, calls),
  });
  const query: EntrezQueryBundle = {
    query: 'What dose of apixaban for a patient with renal insufficiency?',
    keywords: ['apixaban', 'renal', 'insufficiency'],
    entrez: 'apixaban AND "renal insufficiency"[MeSH Terms]',
  };

  // Act
  const results = (await rerank.retrieve(query)).passages;

  // Assert
  assert.deepEqual(source.queries, [query]);
  assert.deepEqual(
    calls.map(({ query }) => query),
    ['What dose of apixaban for a patient with renal insufficiency?'],
  );
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['gamma', 0.5],
      ['alpha', 0.2],
    ],
  );
});

test('the options of the call reach its retriever unchanged, and its abort signal reaches the reranking model', async () => {
  // Arrange
  const seen: RetrieveOptions<StoredPassage>[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const rerank = new RerankRetriever({
    retriever: {
      retrieve: async (
        _query: string,
        options: RetrieveOptions<StoredPassage> = {},
      ) => {
        seen.push(options);
        return search.retrieve();
      },
    },
    model: reranker(relevance, [], signals),
  });
  const controller = new AbortController();
  const options: RetrieveOptions<StoredPassage> = {
    topK: 2,
    includeVectors: true,
    filter: { field: 'source', operator: '==', value: 'guide' },
    signal: controller.signal,
  };

  // Act
  await rerank.retrieve('rotate a key', options);

  // Assert
  assert.deepEqual(seen, [options]);
  assert.deepEqual(signals, [controller.signal]);
});

void test.each(
  [
    [
      undefined,
      0.5,
      relevance,
      [
        ['beta', 0.8],
        ['gamma', 0.5],
      ],
    ],
    [2, 0.6, relevance, [['beta', 0.8]]],
    [
      undefined,
      0,
      { alpha: -0.2, beta: 0.8, gamma: 0 },
      [
        ['beta', 0.8],
        ['gamma', 0],
      ],
    ],
  ] as const,
  ([topN, scoreThreshold, given, kept]) =>
    test(`with topN ${topN} and a scoreThreshold of ${scoreThreshold}, a RerankRetriever keeps the passages whose score from the reranking model is at least the threshold, best first, whatever score they had before (#5734)`, async () => {
      // Arrange: before the rerank, alpha has 0.9 and gamma 0.1; the model
      // gives the relevance of the case.
      const rerank = new RerankRetriever({
        retriever: search,
        model: reranker(given),
        ...(topN === undefined ? {} : { topN }),
        scoreThreshold,
      });

      // Act
      const results = (await rerank.retrieve('rotate a key')).passages;

      // Assert
      assert.deepEqual(
        results.map(({ passage, score }) => [passage.id, score]),
        kept,
      );
    }),
);

void test.each(
  [
    ['an empty string', ''],
    ['a string of white space', ' \t\n'],
    [
      'a query bundle whose query is white space',
      { query: '  ', keywords: ['rotate'] },
    ],
  ] as const,
  ([name, query]) =>
    test(`${name} as the information need is a RangeError before the retriever or the reranking model is called, as EmbeddingRerankRetriever refuses it`, async () => {
      // Arrange
      const calls: Call[] = [];
      const source = new RecordingRetriever(['alpha']);
      const rerank = new RerankRetriever({
        retriever: source,
        model: reranker({ alpha: 0.5 }, calls),
      });
      const need = typeof query === 'string' ? query : query.query;

      // Act and Assert
      await assert.rejects(rerank.retrieve(query), {
        name: 'RangeError',
        message: `The query of a query bundle holds no word: got ${JSON.stringify(need)}`,
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(source.queries, []);
    }),
);
