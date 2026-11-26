import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { MockEmbeddingModelV4 } from 'ai/test';

import { test } from '@zukhruf/parameterized-test';

import {
  EmbeddingRerankRetriever,
  MaximalMarginalRelevance,
  type Passage,
  PostprocessingRetriever,
  type RetrieveOptions,
  RetrieverUnavailableError,
} from './index.ts';
import { embeddingModel } from './testing/embedding-model.ts';
import { LiveRetriever } from './testing/live-retriever.ts';
import type { EntrezQueryBundle } from './testing/recording-retriever.ts';
import { settledThisTurn } from './testing/settled-this-turn.ts';
import { refusesUntypedQuery } from './testing/untyped-query.ts';

// The query 'rotate a key' has the vector [4, 3, 0]. Every vector has length
// 5, so a cosine is the dot product / 25:
//   alpha 20/25 = 0.8, beta 15/25 = 0.6, gamma 0, delta 24/25 = 0.96,
//   epsilon -25/25 = -1, and twin has alpha's vector.
const vectors = {
  'rotate a key': [4, 3, 0],
  alpha: [5, 0, 0],
  beta: [0, 5, 0],
  gamma: [0, 0, 5],
  delta: [3, 4, 0],
  epsilon: [-4, -3, 0],
  twin: [5, 0, 0],
};

// A live source of order only, as a web search gives: alpha, beta, gamma,
// delta. The text of each passage is its id.
const live = () => new LiveRetriever(['alpha', 'beta', 'gamma', 'delta']);

const scores = (
  results: readonly {
    readonly passage: { readonly id: string };
    readonly score: number;
  }[],
) => results.map(({ passage, score }) => [passage.id, score]);

test('a list of order only comes back in the order of the cosine similarity of each text to the query, with that similarity as the score and no vector, since the call did not ask for vectors', async () => {
  // Arrange
  const model = embeddingModel(vectors);
  const rerank = new EmbeddingRerankRetriever({ retriever: live(), model });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

  // Assert: deepEqual of the whole items, so a vector key fails it.
  assert.deepEqual(
    results.map(({ passage, score, ...rest }) => [passage.id, score, rest]),
    [
      ['delta', 0.96, {}],
      ['alpha', 0.8, {}],
      ['beta', 0.6, {}],
      ['gamma', 0, {}],
    ],
  );
  // One call embeds the query, one the texts.
  assert.deepEqual(
    model.doEmbedCalls.map(({ values }) => values).toSorted(),
    [['alpha', 'beta', 'gamma', 'delta'], ['rotate a key']].toSorted(),
  );
});

test('a call with includeVectors: true gets the vector the model made with each passage', async () => {
  // Arrange
  const rerank = new EmbeddingRerankRetriever({
    retriever: live(),
    model: embeddingModel(vectors),
  });

  // Act
  const results = (
    await rerank.retrieve('rotate a key', { includeVectors: true })
  ).passages;

  // Assert
  assert.deepEqual(
    results.map(({ passage, score, vector }) => [passage.id, score, vector]),
    [
      ['delta', 0.96, [3, 4, 0]],
      ['alpha', 0.8, [5, 0, 0]],
      ['beta', 0.6, [0, 5, 0]],
      ['gamma', 0, [0, 0, 5]],
    ],
  );
});

test('a vector that the retriever gives is replaced with the one the model made, so the score never mixes two vector spaces', async () => {
  // Arrange: the source stored a vector of another model for alpha.
  const rerank = new EmbeddingRerankRetriever({
    retriever: {
      retrieve: async () => ({
        passages: [
          {
            passage: { id: 'alpha', text: 'alpha', metadata: {} },
            score: 0.1,
            vector: [0, 0, 5],
          },
        ],
        failures: new Map<string, RetrieverUnavailableError>(),
      }),
    },
    model: embeddingModel(vectors),
  });

  // Act
  const asked = (
    await rerank.retrieve('rotate a key', { includeVectors: true })
  ).passages;
  const unasked = (await rerank.retrieve('rotate a key')).passages;

  // Assert: the stored vector reaches the caller in neither call.
  assert.deepEqual(
    asked.map(({ passage, score, vector }) => [passage.id, score, vector]),
    [['alpha', 0.8, [5, 0, 0]]],
  );
  assert.deepEqual(
    unasked.map(({ passage, score, ...rest }) => [passage.id, score, rest]),
    [['alpha', 0.8, {}]],
  );
});

test('two passages of equal similarity keep the order of the retriever', async () => {
  // Arrange: twin has the vector of alpha and comes first.
  const rerank = new EmbeddingRerankRetriever({
    retriever: new LiveRetriever(['beta', 'twin', 'alpha']),
    model: embeddingModel(vectors),
  });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

  // Assert
  assert.deepEqual(scores(results), [
    ['twin', 0.8],
    ['alpha', 0.8],
    ['beta', 0.6],
  ]);
});

test('topN keeps the best N passages', async () => {
  // Arrange
  const rerank = new EmbeddingRerankRetriever({
    retriever: live(),
    model: embeddingModel(vectors),
    topN: 2,
  });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

  // Assert
  assert.deepEqual(scores(results), [
    ['delta', 0.96],
    ['alpha', 0.8],
  ]);
});

void test.each(
  [[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]] as const,
  ([topN]) =>
    test(`a topN of ${topN} is a RangeError when the EmbeddingRerankRetriever is made`, () => {
      assert.throws(
        () =>
          new EmbeddingRerankRetriever({
            retriever: live(),
            model: embeddingModel(vectors),
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
    [
      undefined,
      0.6,
      [
        ['delta', 0.96],
        ['alpha', 0.8],
        ['beta', 0.6],
      ],
    ],
    [1, 0.6, [['delta', 0.96]]],
    [
      undefined,
      0,
      [
        ['delta', 0.96],
        ['alpha', 0.8],
        ['beta', 0.6],
        ['gamma', 0],
      ],
    ],
  ] as const,
  ([topN, scoreThreshold, kept]) =>
    test(`with topN ${topN} and a scoreThreshold of ${scoreThreshold}, an EmbeddingRerankRetriever keeps the passages whose cosine similarity is at least the threshold, best first (ADR 0019)`, async () => {
      // Arrange: epsilon, opposite to the query, has -1.
      const rerank = new EmbeddingRerankRetriever({
        retriever: new LiveRetriever([
          'alpha',
          'beta',
          'epsilon',
          'gamma',
          'delta',
        ]),
        model: embeddingModel(vectors),
        ...(topN === undefined ? {} : { topN }),
        scoreThreshold,
      });

      // Act
      const results = (await rerank.retrieve('rotate a key')).passages;

      // Assert
      assert.deepEqual(scores(results), kept);
    }),
);

void test.each(
  [
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
  ] as const,
  ([scoreThreshold]) =>
    test(`a scoreThreshold of ${scoreThreshold} is a RangeError when the EmbeddingRerankRetriever is made`, () => {
      assert.throws(
        () =>
          new EmbeddingRerankRetriever({
            retriever: live(),
            model: embeddingModel(vectors),
            scoreThreshold,
          }),
        {
          name: 'RangeError',
          message: `The scoreThreshold is a finite number, not ${scoreThreshold}`,
        },
      );
    }),
);

test('over a live source with no stored vectors, MaximalMarginalRelevance after it diversifies with the vectors it made when the call asks for vectors, where MaximalMarginalRelevance alone fails with VectorMissingError, and so does a call that does not ask', async () => {
  // Arrange
  const model = embeddingModel(vectors);
  const mmr = new MaximalMarginalRelevance({ model, lambda: 0.5, topK: 2 });
  const alone = new PostprocessingRetriever({
    retriever: live(),
    postprocessors: [mmr],
  });
  const reranked = new PostprocessingRetriever({
    retriever: new EmbeddingRerankRetriever({ retriever: live(), model }),
    postprocessors: [mmr],
  });

  // Act
  const results = (
    await reranked.retrieve('rotate a key', { includeVectors: true })
  ).passages;

  // Assert: pick 1 is delta (0.96); pick 2: alpha 0.5 * 0.8 - 0.5 * 0.6 =
  // 0.1, beta 0.5 * 0.6 - 0.5 * 0.8 = -0.1, gamma 0 -> alpha.
  assert.deepEqual(scores(results), [
    ['delta', 0.96],
    ['alpha', 0.8],
  ]);
  await assert.rejects(
    alone.retrieve('rotate a key', { includeVectors: true }),
    { name: 'VectorMissingError' },
  );
  await assert.rejects(reranked.retrieve('rotate a key'), {
    name: 'VectorMissingError',
  });
});

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
    test(`${name} as the information need is a RangeError before any call of its retriever or of the embedding model, as a keyword retriever refuses keywords of no word`, async () => {
      // Arrange
      const model = embeddingModel(vectors);
      const source = live();
      const rerank = new EmbeddingRerankRetriever({ retriever: source, model });
      const need = typeof query === 'string' ? query : query.query;

      // Act and Assert
      await assert.rejects(rerank.retrieve(query), {
        name: 'RangeError',
        message: `The query of a query bundle holds no word: got ${JSON.stringify(need)}`,
      });
      assert.deepEqual(source.queries, []);
      assert.deepEqual(model.doEmbedCalls, []);
    }),
);

refusesUntypedQuery(
  'any call of its retriever or of the embedding model',
  () => {
    const model = embeddingModel(vectors);
    const source = live();
    const retriever = new EmbeddingRerankRetriever({
      retriever: source,
      model,
    });
    return { retriever, calls: [source.queries, model.doEmbedCalls] };
  },
);

test('an empty list gives no passages and makes no call to the embedding model', async () => {
  // Arrange
  const model = embeddingModel(vectors);
  const rerank = new EmbeddingRerankRetriever({
    retriever: new LiveRetriever([]),
    model,
  });

  // Act
  const results = (await rerank.retrieve('rotate a key')).passages;

  // Assert
  assert.deepEqual(results, []);
  assert.deepEqual(model.doEmbedCalls, []);
});

test('an aborted signal rejects with its reason, and starts no search and no call to the embedding model', async () => {
  // Arrange
  const model = embeddingModel(vectors);
  const source = live();
  const rerank = new EmbeddingRerankRetriever({ retriever: source, model });
  const reason = new Error('the caller left');

  // Act
  const outcome = await settledThisTurn(
    rerank.retrieve('rotate a key', { signal: AbortSignal.abort(reason) }),
  );

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(source.queries, []);
  assert.deepEqual(model.doEmbedCalls, []);
});

test("the caller's abort rejects the call at once with the signal's reason, while its retriever ignores its signal and never settles", async () => {
  // Arrange
  const started = Promise.withResolvers<void>();
  const rerank = new EmbeddingRerankRetriever({
    retriever: {
      retrieve: () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
    },
    model: embeddingModel(vectors),
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

test('an abort while its retriever runs makes no call to the embedding model, even when the retriever ignores its signal and answers', async () => {
  // Arrange
  const model = embeddingModel(vectors);
  const controller = new AbortController();
  const reason = new Error('the caller left');
  const source = live();
  const rerank = new EmbeddingRerankRetriever({
    retriever: {
      retrieve: async (query: string) => {
        controller.abort(reason);
        return source.retrieve(query);
      },
    },
    model,
  });

  // Act
  const outcome = await settledThisTurn(
    rerank.retrieve('rotate a key', { signal: controller.signal }),
  );
  await nextTurn();

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(model.doEmbedCalls, []);
});

test('the options of the call reach its retriever unchanged but for includeVectors, which it never asks of its retriever since it attaches only the vectors its model made, its abort signal reaches both calls of the embedding model, and the failures of its retriever pass up unchanged', async () => {
  // Arrange
  const seen: RetrieveOptions<Passage>[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const unavailable = new RetrieverUnavailableError('HTTP 503');
  const source = new LiveRetriever(
    ['alpha', 'beta'],
    new Map([['news', unavailable]]),
  );
  const rerank = new EmbeddingRerankRetriever({
    retriever: {
      retrieve: async (
        query: string,
        options: RetrieveOptions<Passage> = {},
      ) => {
        seen.push(options);
        return source.retrieve(query, options);
      },
    },
    model: embeddingModel(vectors, { signals }),
  });
  const controller = new AbortController();
  const options: RetrieveOptions<Passage> = {
    topK: 2,
    includeVectors: true,
    filter: { field: 'metadata.lang', operator: '==', value: 'en' },
    signal: controller.signal,
  };

  // Act
  const result = await rerank.retrieve('rotate a key', options);

  // Assert: the retriever got the caller's own signal; the query and the two
  // texts each saw a signal that the caller's abort aborts with its reason.
  const { includeVectors: _asked, ...passedDown } = options;
  assert.deepEqual(seen, [passedDown]);
  assert.equal(seen[0]?.signal, controller.signal);
  assert.equal(signals.length, 3);
  const reason = new Error('the caller left');
  controller.abort(reason);
  assert.deepEqual(
    signals.map((signal) => signal?.reason),
    [reason, reason, reason],
  );
  assert.deepEqual([...result.failures], [['news', unavailable]]);
  assert.equal(result.failures.get('news'), unavailable);
});

test('a failing embedding of the query aborts the embedding of the passages and rejects with its own error, so the model is not called in the background after the call failed', async () => {
  // Arrange: the query fails once the passages started; they wait for their
  // signal.
  const down = new Error('the embedding model is down');
  const passageSignals: (AbortSignal | undefined)[] = [];
  const passagesStarted = Promise.withResolvers<void>();
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values, abortSignal }) => {
      if (values.includes('rotate a key')) {
        await passagesStarted.promise;
        throw down;
      }
      passageSignals.push(abortSignal);
      passagesStarted.resolve();
      // An aborted call rejects with an error of its own, as the AI SDK's
      // fetch does, so only the first error can be the call's.
      return await new Promise<never>((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    },
  });
  const rerank = new EmbeddingRerankRetriever({ retriever: live(), model });

  // Act
  const call = rerank.retrieve('rotate a key');

  // Assert
  await assert.rejects(call, (error) => error === down);
  assert.equal(passageSignals.length, 1);
  assert.equal(passageSignals[0]?.aborted, true);
  await nextTurn();
  assert.equal(passageSignals.length, 1);
});

test('a retriever that needs its own field gets the query bundle unchanged, while the embedding model embeds the information need', async () => {
  // Arrange
  const model = embeddingModel({
    ...vectors,
    'What dose of apixaban?': [4, 3, 0],
  });
  const source = new LiveRetriever<EntrezQueryBundle>(['alpha', 'delta']);
  const rerank = new EmbeddingRerankRetriever({ retriever: source, model });
  const query: EntrezQueryBundle = {
    query: 'What dose of apixaban?',
    keywords: ['apixaban'],
    customEmbeddings: ['A hypothetical label on apixaban'],
    entrez: 'apixaban[MeSH Terms]',
  };

  // Act
  const results = (await rerank.retrieve(query)).passages;

  // Assert
  assert.deepEqual(source.queries, [query]);
  assert.deepEqual(
    model.doEmbedCalls.map(({ values }) => values).toSorted(),
    [['What dose of apixaban?'], ['alpha', 'delta']].toSorted(),
  );
  assert.deepEqual(scores(results), [
    ['delta', 0.96],
    ['alpha', 0.8],
  ]);
});

test('a zero vector of a text has no cosine similarity, so it is a TypeError that names the passage', async () => {
  // Arrange
  const rerank = new EmbeddingRerankRetriever({
    retriever: live(),
    model: embeddingModel({ ...vectors, gamma: [0, 0, 0] }),
  });

  // Act and Assert
  await assert.rejects(rerank.retrieve('rotate a key'), {
    name: 'TypeError',
    message:
      'EmbeddingRerankRetriever scores by cosine similarity, and the passage gamma has the score NaN: a score is a finite number',
  });
});

test('a zero vector of the query has no cosine similarity, so it is a TypeError that names the query, not a passage', async () => {
  // Arrange
  const rerank = new EmbeddingRerankRetriever({
    retriever: live(),
    model: embeddingModel({ ...vectors, 'rotate a key': [0, 0, 0] }),
  });

  // Act and Assert
  await assert.rejects(rerank.retrieve('rotate a key'), {
    name: 'TypeError',
    message:
      'EmbeddingRerankRetriever scores by cosine similarity, and the vector of the query has the cosine similarity NaN with itself: a score is a finite number',
  });
});

test('the passages are embedded while the embedding of the query is still open: the two calls run at the same time', async () => {
  // Arrange: the call for the query waits until the test lets it go.
  const inner = embeddingModel(vectors);
  const held = Promise.withResolvers<void>();
  const passagesStarted = Promise.withResolvers<'passages started'>();
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async (options) => {
      if (options.values.includes('rotate a key')) await held.promise;
      else passagesStarted.resolve('passages started');
      return inner.doEmbed(options);
    },
  });
  const rerank = new EmbeddingRerankRetriever({ retriever: live(), model });

  // Act
  const call = rerank.retrieve('rotate a key');
  const outcome = await Promise.race([
    passagesStarted.promise,
    settledThisTurn(call),
  ]);
  held.resolve();
  const { passages } = await call;

  // Assert
  assert.equal(outcome, 'passages started');
  assert.deepEqual(
    passages.map(({ passage }) => passage.id),
    ['delta', 'alpha', 'beta', 'gamma'],
  );
});

test('an error of the embedding model reaches the caller as it is', async () => {
  // Arrange: the model names no vector for 'zeta'.
  const rerank = new EmbeddingRerankRetriever({
    retriever: new LiveRetriever(['alpha', 'zeta']),
    model: embeddingModel(vectors),
  });

  // Act and Assert
  await assert.rejects(rerank.retrieve('rotate a key'), {
    message: 'The test names no vector for zeta',
  });
});
