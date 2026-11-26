import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { MockLanguageModelV4, MockRerankingModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { test } from '@zukhruf/testing/node';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import {
  FusionRetriever,
  HydeRetriever,
  type QueryBundle,
  RerankRetriever,
  RetrieverUnavailableError,
} from './index.ts';
import { SqliteEmbeddingRetriever, SqlitePassageStore } from './sqlite.ts';
import { embeddingModel } from './testing/embedding-model.ts';
import { LiveRetriever } from './testing/live-retriever.ts';
import {
  type EntrezQueryBundle,
  RecordingRetriever,
} from './testing/recording-retriever.ts';
import { settledThisTurn } from './testing/settled-this-turn.ts';

// The passages and their vectors as elt's Vectorizer writes them.
function contract(): DatabaseSync {
  const database = open(':memory:');
  install(database);
  database.exec(`
    CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT) STRICT;
    CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT;
  `);
  const passage = database.prepare(
    `INSERT INTO docs_passages VALUES (?, ?, 0, 0, 10, ?, ?)`,
  );
  const vector = database.prepare(
    `INSERT INTO docs_passage_vectors VALUES (?, ?, 'test/mini (2 dimensions)')`,
  );
  for (const [id, product, values] of [
    ['exact-b', 'b', [1, 0]],
    ['near-a', 'a', [2, 1]],
    ['far-a', 'a', [0, 1]],
  ] as const) {
    passage.run(id, `doc-${id}`, `text of ${id}`, product);
    vector.run(id, toSql(Vector.from(values)));
  }
  return database;
}

const answer =
  'To rotate a signing key, create a new key and retire the old one.';

// The embedding model knows a vector only for the answer of the language
// model, so a search with any other text fails.
const meaning = (
  database: DatabaseSync,
  signals: (AbortSignal | undefined)[] = [],
) =>
  new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel({ [answer]: [1, 0] }, { signals }),
  });

type Call = {
  readonly prompt: string;
  readonly abortSignal: AbortSignal | undefined;
};

// A real language model cannot run in CI. The AI SDK's own mock model gives
// the answer and records the prompt of each call.
function languageModel(calls: Call[] = []): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt, abortSignal }) => {
      calls.push({
        prompt: prompt
          .flatMap((message) =>
            message.role === 'user'
              ? message.content.flatMap((part) =>
                  part.type === 'text' ? [part.text] : [],
                )
              : [],
          )
          .join('\n'),
        abortSignal,
      });
      return {
        content: [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

test("the model writes a passage that answers the query with LangChain's websearch prompt, and the passage is searched with the topK, filter and includeVectors of the call", async () => {
  // Arrange
  using database = contract();
  const calls: Call[] = [];
  const retriever = new HydeRetriever({
    retriever: meaning(database),
    model: languageModel(calls),
  });

  // Act
  const results = (
    await retriever.retrieve('how do I change my signing key?', {
      topK: 1,
      filter: { field: 'metadata.product', operator: '==', value: 'a' },
      includeVectors: true,
    })
  ).passages;

  // Assert: the "websearch" template of getPromptTemplateFromKey in
  // LangChain's hyde.ts. exact-b is nearest but the filter leaves it out;
  // near-a [2, 1] has the cosine 2 / sqrt(5) = 0.894427 to [1, 0].
  assert.deepEqual(
    calls.map(({ prompt }) => prompt),
    [
      'Please write a passage to answer the question\nQuestion: how do I change my signing key?\nPassage:',
    ],
  );
  assert.deepEqual(
    results.map(({ passage, vector }) => [passage.id, vector]),
    [['near-a', [2, 1]]],
  );
  assert.ok(Math.abs((results[0]?.score ?? 0) - 2 / Math.sqrt(5)) < 1e-6);
});

test('the passage reaches the embedding search only, as customEmbeddings: the query and its keywords stay, and a reranker below ranks against the query', async () => {
  // Arrange: a reranking stack over a fusion of a recording source and an
  // embedding search, whose model knows a vector only for the passage.
  using database = contract();
  const source = new RecordingRetriever(['kw-1']);
  const reranked: string[] = [];
  const stack = new RerankRetriever({
    retriever: new FusionRetriever({
      retrievers: {
        source: { retriever: source },
        meaning: { retriever: meaning(database) },
      },
    }),
    model: new MockRerankingModelV4({
      doRerank: async ({ documents, query }) => {
        reranked.push(query);
        return {
          ranking: documents.values.map((_, index) => ({
            index,
            relevanceScore: 1 / (index + 1),
          })),
        };
      },
    }),
  });
  const retriever = new HydeRetriever({
    retriever: stack,
    model: languageModel(),
  });
  const query: QueryBundle = {
    query: 'how do I change my signing key?',
    keywords: ['signing', 'key'],
  };

  // Act
  const results = (await retriever.retrieve(query)).passages;

  // Assert
  assert.deepEqual(source.queries, [{ ...query, customEmbeddings: [answer] }]);
  assert.deepEqual(reranked, ['how do I change my signing key?']);
  assert.deepEqual(results.map(({ passage }) => passage.id).toSorted(), [
    'exact-b',
    'far-a',
    'kw-1',
    'near-a',
  ]);
});

test('HyDE takes a retriever of any query bundle: not one of strings only, nor a host source that needs its own field, which is fused beside HyDE', async () => {
  // Arrange
  using database = contract();
  const host = new RecordingRetriever<EntrezQueryBundle>(['pmid-1']);
  const federation = new FusionRetriever({
    retrievers: {
      host: { retriever: host },
      hyde: {
        retriever: new HydeRetriever({
          retriever: meaning(database),
          model: languageModel(),
        }),
      },
    },
  });
  const query: EntrezQueryBundle = {
    query: 'how do I change my signing key?',
    entrez: 'signing AND key[Title]',
  };

  // Act
  const results = (await federation.retrieve(query)).passages;

  // Assert: the host gets its field and no passage; the passage finds exact-b.
  assert.deepEqual(host.queries, [query]);
  assert.deepEqual(results.map(({ passage }) => passage.id).toSorted(), [
    'exact-b',
    'far-a',
    'near-a',
    'pmid-1',
  ]);
  // Each line after a directive is a compile error, which the typecheck
  // target proves; the function never runs.
  const refused = () => [
    new HydeRetriever({
      // @ts-expect-error: HyDE sends a query bundle, which a retriever of strings only cannot take
      retriever: new RecordingRetriever<string>([]),
      model: languageModel(),
    }),
    new HydeRetriever({
      // @ts-expect-error: HyDE sends a query bundle without entrez
      retriever: host,
      model: languageModel(),
    }),
  ];
  assert.equal(typeof refused, 'function');
});

test('the abort signal of the call reaches the model and the search', async () => {
  // Arrange
  using database = contract();
  const calls: Call[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const given = new AbortController();
  const retriever = new HydeRetriever({
    retriever: meaning(database, signals),
    model: languageModel(calls),
  });

  // Act
  await retriever.retrieve('rotate a key', { signal: given.signal });

  // Assert
  assert.equal(calls[0]?.abortSignal, given.signal);
  assert.deepEqual(signals, [given.signal]);
});

test('a failed model call rejects', async () => {
  // Arrange
  using database = contract();
  const failing = new HydeRetriever({
    retriever: meaning(database),
    model: new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The model is down');
      },
    }),
  });

  // Act and Assert
  await assert.rejects(failing.retrieve('rotate a key'), {
    message: 'The model is down',
  });
});

test('the failures of the retriever pass up unchanged, and its list of order only keeps no score', async () => {
  // Arrange
  const unavailable = new RetrieverUnavailableError('HTTP 503');
  const live = new LiveRetriever<QueryBundle>(
    ['web-1', 'web-2'],
    new Map([['news', unavailable]]),
  );
  const retriever = new HydeRetriever({
    retriever: live,
    model: languageModel(),
  });

  // Act
  const result = await retriever.retrieve('how do I change my signing key?');

  // Assert
  assert.deepEqual(
    result.passages.map((scored) => [scored.passage.id, 'score' in scored]),
    [
      ['web-1', false],
      ['web-2', false],
    ],
  );
  assert.deepEqual([...result.failures], [['news', unavailable]]);
  assert.equal(result.failures.get('news'), unavailable);
});

test("the caller's abort rejects the call at once with the signal's reason, while the model ignores its signal and never answers", async () => {
  // Arrange
  using database = contract();
  const writing = Promise.withResolvers<void>();
  const retriever = new HydeRetriever({
    retriever: meaning(database),
    model: new MockLanguageModelV4({
      doGenerate: () => {
        writing.resolve();
        return new Promise(() => {});
      },
    }),
  });
  const controller = new AbortController();
  const reason = new Error('the caller left');

  // Act
  const call = retriever.retrieve('rotate a key', {
    signal: controller.signal,
  });
  await writing.promise;
  controller.abort(reason);
  const outcome = await settledThisTurn(call);

  // Assert
  assert.equal(outcome, reason);
});

test('an aborted signal rejects the call with its reason and calls neither the model nor the retriever', async () => {
  // Arrange: the AI SDK's generateText calls a model with an aborted signal
  // (ai 7.0.179), so only the check of HydeRetriever keeps the model idle.
  const searched: QueryBundle[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: () => new Promise(() => {}),
  });
  const retriever = new HydeRetriever({
    retriever: {
      retrieve: (query: QueryBundle) => {
        searched.push(query);
        return new Promise<never>(() => {});
      },
    },
    model,
  });
  const reason = new Error('the caller left');

  // Act
  const outcome = await settledThisTurn(
    retriever.retrieve('rotate a key', { signal: AbortSignal.abort(reason) }),
  );
  // A model call would start in the microtasks after the rejection.
  await nextTurn();

  // Assert
  assert.equal(outcome, reason);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.deepEqual(searched, []);
});

test("the caller's abort rejects the call at once with the signal's reason, while the retriever ignores its signal and never settles", async () => {
  // Arrange
  const searching = Promise.withResolvers<void>();
  const retriever = new HydeRetriever({
    retriever: {
      retrieve: () => {
        searching.resolve();
        return new Promise<never>(() => {});
      },
    },
    model: languageModel(),
  });
  const controller = new AbortController();
  const reason = new Error('the caller left');

  // Act
  const call = retriever.retrieve('rotate a key', {
    signal: controller.signal,
  });
  await searching.promise;
  controller.abort(reason);
  const outcome = await settledThisTurn(call);

  // Assert
  assert.equal(outcome, reason);
});

void test.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY], (topK) =>
  test(`a topK of ${topK} in the call is a RangeError before the model or the retriever is called, as Elasticsearch refuses a bad size`, async () => {
    // Arrange: the retriever below checks no topK of its own.
    const calls: Call[] = [];
    const source = new RecordingRetriever<QueryBundle>(['kw-1']);
    const retriever = new HydeRetriever({
      retriever: source,
      model: languageModel(calls),
    });

    // Act
    const call = retriever.retrieve('how do I change my signing key?', {
      topK,
    });

    // Assert
    await assert.rejects(call, {
      name: 'RangeError',
      message: `The topK is a whole number of 0 or more, not ${topK}`,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(source.queries, []);
  }),
);
