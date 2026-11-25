import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { RerankingModel } from 'ai';

import { open } from '@zukhruf/sqlite-open';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import {
  MaximalMarginalRelevance,
  PostprocessingRetriever,
  type Postprocessor,
  type QueryType,
  Rerank,
  RetrieverUnavailableError,
  type StoredPassage,
} from './index.ts';
import { SqliteEmbeddingRetriever, SqlitePassageStore } from './sqlite.ts';
import { embeddingModel } from './testing/embedding-model.ts';
import { LiveRetriever } from './testing/live-retriever.ts';
import {
  type EntrezQueryBundle,
  RecordingRetriever,
} from './testing/recording-retriever.ts';
import { settledThisTurn } from './testing/settled-this-turn.ts';

// The passages and their vectors, as elt writes them. Each vector has length
// 5; the cosine similarities to the query [4, 3, 0] are alpha 20/25 = 0.8,
// delta 16/25 = 0.64, beta 15/25 = 0.6 and gamma 0, so the search ranks
// alpha, delta, beta, gamma.
const vectors = {
  alpha: [5, 0, 0],
  beta: [0, 5, 0],
  gamma: [0, 0, 5],
  delta: [4, 0, 3],
};

function knowledge(): DatabaseSync {
  const database = open(':memory:');
  install(database);
  database.exec(`
    CREATE TABLE kb_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
    CREATE TABLE kb_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT;
  `);
  for (const [text, vector] of Object.entries(vectors)) {
    database
      .prepare(`INSERT INTO kb_passages VALUES (?, 'kb', 0, 0, 5, ?)`)
      .run(text, text);
    database
      .prepare(
        `INSERT INTO kb_vectors VALUES (?, ?, 'test/mini (3 dimensions)')`,
      )
      .run(text, toSql(Vector.from(vector)));
  }
  return database;
}

// The query 'rotate a key' has the vector [4, 3, 0].
const embeddings = (signals: (AbortSignal | undefined)[]) =>
  embeddingModel({ 'rotate a key': [4, 3, 0] }, { signals });

const search = (
  database: DatabaseSync,
  signals: (AbortSignal | undefined)[] = [],
) =>
  new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'kb_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'kb_vectors',
    model: embeddings(signals),
  });

type Seen = {
  readonly query: string;
  readonly abortSignal: AbortSignal | undefined;
};

// A reranking model cannot run in CI. This one gives delta 0.9, beta 0.4,
// gamma 0.3 and alpha 0.1, best first, and records the query and the abort
// signal of each call.
const reranker = (seen: Seen[] = []): RerankingModel => ({
  specificationVersion: 'v4',
  provider: 'test',
  modelId: 'rerank-mini',
  async doRerank({ documents, query, abortSignal }) {
    seen.push({ query, abortSignal });
    const relevance = new Map([
      ['delta', 0.9],
      ['beta', 0.4],
      ['gamma', 0.3],
      ['alpha', 0.1],
    ]);
    return {
      ranking: documents.values
        .map((text, index) => {
          const relevanceScore = relevance.get(String(text));
          if (relevanceScore === undefined)
            throw new Error(`The test ranks no ${String(text)}`);
          return { index, relevanceScore };
        })
        .toSorted((a, b) => b.relevanceScore - a.relevanceScore),
    };
  },
});

const scores = (
  results: readonly {
    readonly passage: { readonly id: string };
    readonly score?: number;
  }[],
) => results.map(({ passage, score }) => [passage.id, score]);

test('the postprocessors run in their order, each on the list of the one before it', async () => {
  // Arrange: a host's cutoff for a score whose scale it knows.
  using database = knowledge();
  const cutoff: Postprocessor<StoredPassage> = {
    postprocess: async (passages) =>
      passages.filter(({ score }) => score !== undefined && score >= 0.5),
  };
  const rerankThenCut = new PostprocessingRetriever({
    retriever: search(database),
    postprocessors: [new Rerank({ model: reranker() }), cutoff],
  });
  const cutThenRerank = new PostprocessingRetriever({
    retriever: search(database),
    postprocessors: [cutoff, new Rerank({ model: reranker() })],
  });

  // Act
  const reranked = (await rerankThenCut.retrieve('rotate a key')).passages;
  const cut = (await cutThenRerank.retrieve('rotate a key')).passages;

  // Assert: the cutoff after the reranker keeps delta 0.9 only; the cutoff
  // before it keeps alpha 0.8, delta 0.64 and beta 0.6 of the cosines, which
  // the reranker orders delta 0.9, beta 0.4, alpha 0.1.
  assert.deepEqual(scores(reranked), [['delta', 0.9]]);
  assert.deepEqual(scores(cut), [
    ['delta', 0.9],
    ['beta', 0.4],
    ['alpha', 0.1],
  ]);
});

test('the query and the abort signal of the call reach the retriever and each postprocessor', async () => {
  // Arrange
  using database = knowledge();
  const searched: (AbortSignal | undefined)[] = [];
  const reranked: Seen[] = [];
  const retriever = new PostprocessingRetriever({
    retriever: search(database, searched),
    postprocessors: [
      new Rerank({ model: reranker(reranked) }),
      new Rerank({ model: reranker(reranked) }),
    ],
  });
  const controller = new AbortController();

  // Act
  await retriever.retrieve('rotate a key', { signal: controller.signal });

  // Assert
  assert.deepEqual(searched, [controller.signal]);
  assert.deepEqual(reranked, [
    { query: 'rotate a key', abortSignal: controller.signal },
    { query: 'rotate a key', abortSignal: controller.signal },
  ]);
});

test('a retriever that needs its own field gets the query bundle unchanged, while each postprocessor gets its query, the information need', async () => {
  // Arrange: the source records what it gets; its passages have the texts
  // alpha and delta, which the reranker scores.
  const source = new RecordingRetriever<EntrezQueryBundle>(['alpha', 'delta']);
  const reranked: Seen[] = [];
  const retriever = new PostprocessingRetriever({
    retriever: source,
    postprocessors: [new Rerank({ model: reranker(reranked) })],
  });
  const query: EntrezQueryBundle = {
    query: 'What dose of apixaban for a patient with renal insufficiency?',
    keywords: ['apixaban', 'renal', 'insufficiency'],
    entrez: 'apixaban AND "renal insufficiency"[MeSH Terms]',
  };

  // Act
  const results = (await retriever.retrieve(query)).passages;

  // Assert
  assert.deepEqual(source.queries, [query]);
  assert.deepEqual(
    reranked.map(({ query }) => query),
    ['What dose of apixaban for a patient with renal insufficiency?'],
  );
  assert.deepEqual(scores(results), [
    ['delta', 0.9],
    ['alpha', 0.1],
  ]);
});

test('MaximalMarginalRelevance diversifies with the stored vectors when the call asks for them, and a call without includeVectors is a VectorMissingError before its model call', async () => {
  // Arrange
  using database = knowledge();
  const diversified: (AbortSignal | undefined)[] = [];
  const retriever = new PostprocessingRetriever({
    retriever: search(database),
    postprocessors: [
      new MaximalMarginalRelevance({ model: embeddings(diversified), topK: 2 }),
    ],
  });

  // Act
  const results = (
    await retriever.retrieve('rotate a key', {
      includeVectors: true,
    })
  ).passages;

  // Assert: the most relevant is alpha; then 0.5 * relevance - 0.5 *
  // similarity to alpha: beta 0.3 - 0 = 0.3, gamma 0 - 0 = 0, delta 0.32 -
  // 0.5 * 20/25 = -0.08, so beta.
  assert.deepEqual(
    results.map(({ passage, vector }) => [passage.id, vector]),
    [
      ['alpha', [5, 0, 0]],
      ['beta', [0, 5, 0]],
    ],
  );
  assert.equal(diversified.length, 1);
  await assert.rejects(retriever.retrieve('rotate a key'), {
    name: 'VectorMissingError',
    passageId: 'alpha',
  });
  assert.equal(diversified.length, 1);
});

test('the failures of the retriever pass up unchanged, and a Rerank gives a score to every passage of a list of order only', async () => {
  // Arrange: a live source that gives an order only and names one child
  // that was unavailable.
  const unavailable = new RetrieverUnavailableError('HTTP 503');
  const failures = new Map([['news', unavailable]]);
  const reranked = new PostprocessingRetriever({
    retriever: new LiveRetriever(['alpha', 'beta', 'gamma', 'delta'], failures),
    postprocessors: [new Rerank({ model: reranker() })],
  });

  // Act
  const rerankedResult = await reranked.retrieve('rotate a key');

  // Assert
  assert.deepEqual(scores(rerankedResult.passages), [
    ['delta', 0.9],
    ['beta', 0.4],
    ['gamma', 0.3],
    ['alpha', 0.1],
  ]);
  assert.deepEqual([...rerankedResult.failures], [['news', unavailable]]);
  assert.equal(rerankedResult.failures.get('news'), unavailable);
});

test("the caller's abort rejects the call at once with the signal's reason, while a postprocessor ignores its signal and never settles", async () => {
  // Arrange
  const started = Promise.withResolvers<void>();
  const postprocessor: Postprocessor<StoredPassage> = {
    postprocess: () => {
      started.resolve();
      return new Promise(() => {});
    },
  };
  const retriever = new PostprocessingRetriever({
    retriever: new RecordingRetriever(['a']),
    postprocessors: [postprocessor],
  });
  const controller = new AbortController();
  const reason = new Error('the caller left');

  // Act
  const call = retriever.retrieve('rotate a key', {
    signal: controller.signal,
  });
  await started.promise;
  controller.abort(reason);
  const outcome = await settledThisTurn(call);

  // Assert
  assert.equal(outcome, reason);
});

test("the caller's abort rejects the call at once with the signal's reason, while the retriever ignores its signal and never settles, and an aborted signal starts no search", async () => {
  // Arrange
  const searched: QueryType[] = [];
  const retriever = new PostprocessingRetriever({
    retriever: {
      retrieve: (query: QueryType) => {
        searched.push(query);
        return new Promise<never>(() => {});
      },
    },
    postprocessors: [],
  });
  const controller = new AbortController();
  const reason = new Error('the caller left');

  // Act
  const call = settledThisTurn(
    retriever.retrieve('rotate a key', { signal: controller.signal }),
  );
  controller.abort(reason);
  const early = settledThisTurn(
    retriever.retrieve('expire a key', { signal: AbortSignal.abort(reason) }),
  );
  const outcomes = await Promise.all([call, early]);

  // Assert
  assert.deepEqual(outcomes, [reason, reason]);
  assert.deepEqual(searched, ['rotate a key']);
});

test('an abort while a postprocessor runs stops the list there: the postprocessors after it never run, even when that one ignores its signal and answers', async () => {
  // Arrange
  const controller = new AbortController();
  const reason = new Error('the caller left');
  const later: string[] = [];
  const retriever = new PostprocessingRetriever({
    retriever: new RecordingRetriever(['a']),
    postprocessors: [
      {
        postprocess: async (passages) => {
          controller.abort(reason);
          return [...passages];
        },
      },
      {
        postprocess: async (passages, query) => {
          later.push(query);
          return [...passages];
        },
      },
    ],
  });

  // Act
  const outcome = await settledThisTurn(
    retriever.retrieve('rotate a key', { signal: controller.signal }),
  );
  await nextTurn();

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(later, []);
});
