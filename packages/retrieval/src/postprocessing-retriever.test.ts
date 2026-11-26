import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { RerankingModel } from 'ai';

import { open } from '@zukhruf/sqlite-open';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import {
  Collapse,
  MaximalMarginalRelevance,
  PostprocessingRetriever,
  type Postprocessor,
  type QueryType,
  RerankRetriever,
  type RetrieveOptions,
  RetrieverUnavailableError,
  type ScoredPassage,
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

test('a cutoff over a RerankRetriever cuts the scores of the reranking model, and one under it cuts the scores of the search, which the RerankRetriever then reranks', async () => {
  // Arrange: a host's cutoff for a score whose scale it knows.
  using database = knowledge();
  const cutoff: Postprocessor<StoredPassage, ScoredPassage<StoredPassage>> = {
    postprocess: async (passages) =>
      passages.filter(({ score }) => score >= 0.5),
  };
  const rerankThenCut = new PostprocessingRetriever({
    retriever: new RerankRetriever({
      retriever: search(database),
      model: reranker(),
    }),
    postprocessors: [cutoff],
  });
  const cutThenRerank = new RerankRetriever({
    retriever: new PostprocessingRetriever({
      retriever: search(database),
      postprocessors: [cutoff],
    }),
    model: reranker(),
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
  const seen: Seen[] = [];
  const recorder: Postprocessor<StoredPassage, ScoredPassage<StoredPassage>> = {
    postprocess: async (passages, query, options) => {
      seen.push({ query, abortSignal: options?.signal });
      return [...passages];
    },
  };
  const retriever = new PostprocessingRetriever({
    retriever: search(database, searched),
    postprocessors: [recorder, recorder],
  });
  const controller = new AbortController();

  // Act
  await retriever.retrieve('rotate a key', { signal: controller.signal });

  // Assert
  assert.deepEqual(searched, [controller.signal]);
  assert.deepEqual(seen, [
    { query: 'rotate a key', abortSignal: controller.signal },
    { query: 'rotate a key', abortSignal: controller.signal },
  ]);
});

test('a retriever that needs its own field gets the query bundle unchanged, while each postprocessor gets its query, the information need', async () => {
  // Arrange: the source records what it gets; its passages have the texts
  // alpha and delta, which the reranker under the postprocessor scores.
  const source = new RecordingRetriever<EntrezQueryBundle>(['alpha', 'delta']);
  const reranked: Seen[] = [];
  const postprocessed: string[] = [];
  const retriever = new PostprocessingRetriever({
    retriever: new RerankRetriever({
      retriever: source,
      model: reranker(reranked),
    }),
    postprocessors: [
      {
        postprocess: async (passages, query) => {
          postprocessed.push(query);
          return [...passages];
        },
      },
    ],
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
  assert.deepEqual(postprocessed, [
    'What dose of apixaban for a patient with renal insufficiency?',
  ]);
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

test('with a rankWindowSize, MaximalMarginalRelevance picks from the whole window, which the retriever gives with the other options of the call unchanged, and the call gives the topK first picks, one of which sits past that topK in the order of the search', async () => {
  // Arrange: a host wrapper of the search that records its options and
  // names one failure.
  using database = knowledge();
  const engine = search(database);
  const seen: RetrieveOptions<StoredPassage>[] = [];
  const unavailable = new RetrieverUnavailableError('HTTP 503');
  const retriever = new PostprocessingRetriever({
    retriever: {
      retrieve: async (
        query: string,
        options: RetrieveOptions<StoredPassage> = {},
      ) => {
        seen.push(options);
        const { passages } = await engine.retrieve(query, options);
        return { passages, failures: new Map([['news', unavailable]]) };
      },
    },
    rankWindowSize: 4,
    postprocessors: [
      new MaximalMarginalRelevance({ model: embeddings([]), topK: 3 }),
    ],
  });
  const options: RetrieveOptions<StoredPassage> = {
    topK: 2,
    includeVectors: true,
    filter: { field: 'source', operator: '==', value: 'kb' },
    signal: new AbortController().signal,
  };

  // Act
  const result = await retriever.retrieve('rotate a key', options);

  // Assert: the search ranks alpha, delta, beta, gamma; MMR picks alpha,
  // then beta 0.3 over gamma 0 and delta -0.08, then gamma; the call gives
  // the first 2. From the first 2 of the search, MMR would pick alpha, delta.
  assert.deepEqual(seen, [{ ...options, topK: 4 }]);
  assert.deepEqual(
    result.passages.map(({ passage }) => passage.id),
    ['alpha', 'beta'],
  );
  assert.deepEqual([...result.failures], [['news', unavailable]]);
});

test('a host postprocessor that gives more passages than it got still leaves the call with at most the topK of the call (ADR 0006)', async () => {
  // Arrange
  const doubling: Postprocessor = {
    postprocess: async (passages) => [...passages, ...passages],
  };
  const retriever = new PostprocessingRetriever({
    retriever: new LiveRetriever(['alpha', 'beta', 'gamma']),
    postprocessors: [doubling],
  });

  // Act
  const results = (await retriever.retrieve('rotate a key', { topK: 2 }))
    .passages;

  // Assert
  assert.deepEqual(
    results.map(({ passage }) => passage.id),
    ['alpha', 'beta'],
  );
});

test('a Collapse after MaximalMarginalRelevance keeps the order of its picks, not the order of the scores', async () => {
  // Arrange: four picks, then the first three of the one source.
  using database = knowledge();
  const retriever = new PostprocessingRetriever({
    retriever: search(database),
    postprocessors: [
      new MaximalMarginalRelevance({ model: embeddings([]), topK: 4 }),
      new Collapse({ size: 3 }),
    ],
  });

  // Act
  const results = (
    await retriever.retrieve('rotate a key', { includeVectors: true })
  ).passages;

  // Assert: MMR picks alpha, then beta 0.3 over delta -0.08, then gamma 0
  // (redundancy 0) over delta 0.32 - 0.5 * 0.8 = -0.08, then delta; by score
  // the three would be alpha 0.8, delta 0.64, beta 0.6.
  assert.deepEqual(
    results.map(({ passage }) => passage.id),
    ['alpha', 'beta', 'gamma'],
  );
});

test('the failures of the retriever pass up unchanged, and a RerankRetriever under it gives a score to every passage of a list of order only', async () => {
  // Arrange: a live source that gives an order only and names one child
  // that was unavailable.
  const unavailable = new RetrieverUnavailableError('HTTP 503');
  const failures = new Map([['news', unavailable]]);
  const reranked = new PostprocessingRetriever({
    retriever: new RerankRetriever({
      retriever: new LiveRetriever(
        ['alpha', 'beta', 'gamma', 'delta'],
        failures,
      ),
      model: reranker(),
    }),
    postprocessors: [],
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
  const postprocessor: Postprocessor<
    StoredPassage,
    ScoredPassage<StoredPassage>
  > = {
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
