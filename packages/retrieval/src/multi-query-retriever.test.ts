import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { MockLanguageModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { test } from '@zukhruf/testing/node';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import {
  type Fusion,
  type FusionInput,
  MultiQueryRetriever,
  type Passage,
  type QueryType,
  type RankedDoc,
  type RetrievalResult,
  type RetrieveOptions,
  RetrieverUnavailableError,
  ScoreFusion,
  type ScoredPassage,
  max,
  minMax,
  none,
  sum,
} from './index.ts';
import {
  SqliteBM25Retriever,
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from './sqlite.ts';
import { embeddingModel } from './testing/embedding-model.ts';
import { writeKeywordContract } from './testing/keyword-contract.ts';
import { RecordingRetriever } from './testing/recording-retriever.ts';
import { settledThisTurn } from './testing/settled-this-turn.ts';

// Each passage matches one query of the tests, and its vector is the one
// that the embedding model gives for that query.
const rows = [
  { id: 'alpha', text: 'rotate key', vector: [1, 0, 0, 0] },
  { id: 'beta', text: 'revoke token', vector: [0, 1, 0, 0] },
  { id: 'gamma', text: 'renew certificate', vector: [0, 0, 1, 0] },
  { id: 'delta', text: 'expire session', vector: [0, 0, 0, 1] },
  { id: 'eps', text: 'reset password', vector: [0, 0, -1, 0] },
] as const;

// The passage contract as elt writes it: the passages, an FTS5 keyword index
// with a keywords table as its external content, as ADR 0004 has it, and
// the passage vectors.
function contract(
  passages: readonly {
    readonly id: string;
    readonly text: string;
    readonly vector: readonly number[];
  }[] = rows,
): DatabaseSync {
  const database = open(':memory:');
  install(database);
  writeKeywordContract(
    database,
    passages.map(({ id, text }) => ({
      id,
      text,
      product: id === 'beta' ? 'b' : 'a',
    })),
  );
  database.exec(
    'CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT',
  );
  const vector = database.prepare(
    `INSERT INTO docs_passage_vectors VALUES (?, ?, 'test/mini (4 dimensions)')`,
  );
  for (const row of passages)
    vector.run(row.id, toSql(Vector.from(row.vector)));
  return database;
}

const keywords = (database: DatabaseSync) =>
  new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

type Call = {
  readonly prompt: string;
  readonly abortSignal: AbortSignal | undefined;
};

// A real language model cannot run in CI. The AI SDK's own mock model gives
// the answer that the test names and records the prompt of each call.
function languageModel(
  answer: string,
  calls: Call[] = [],
): MockLanguageModelV4 {
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

const queries = (...versions: readonly string[]) =>
  JSON.stringify({ queries: versions });

const scores = (
  results: readonly {
    readonly passage: { readonly id: string };
    readonly score?: number;
  }[],
) => results.map(({ passage, score }) => [passage.id, score]);

// DEFAULT_PROMPT_TEMPLATE of Haystack's QueryExpander
// (haystack/components/query/query_expander.py, lines 22-52).
const haystackPrompt = (count: number, query: string) =>
  `You are part of an information system that processes user queries for retrieval.
You have to expand a given query into ${count} queries that are
semantically similar to improve retrieval recall.

Structure:
Follow the structure shown below in examples to generate expanded queries.
These examples show the output when 3 queries are requested.

Examples:
1.  Query: "climate change effects"
    {"queries": ["impact of climate change", "consequences of global warming", "effects of environmental changes"]}

2.  Query: "machine learning algorithms"
    {"queries": ["neural networks", "clustering techniques", "supervised learning methods"]}

3.  Query: "open source NLP frameworks"
    {"queries": ["natural language processing tools", "free nlp libraries", "open-source NLP platforms"]}

Guidelines:
- Generate queries that use different words and phrasings
- Include synonyms and related terms
- Maintain the same core meaning and intent
- Make queries that are likely to retrieve relevant information the original might miss
- Focus on variations that would work well with keyword-based search
- Respond in the same language as the input query

Your Task:
Query: "${query}"

You *must* respond with a JSON object containing a "queries" array with exactly ${count} expanded queries.`;

test('an answer of the model that is not a "queries" array of strings rejects', async () => {
  // Arrange
  using database = contract();
  const answers = [
    { answer: 'rotate key' },
    { queries: 'rotate key' },
    { queries: ['rotate key', 3] },
  ].map(
    (answer) =>
      new MultiQueryRetriever({
        retriever: keywords(database),
        model: languageModel(JSON.stringify(answer)),
      }),
  );

  // Act and Assert
  for (const retriever of answers) {
    await assert.rejects(retriever.retrieve('rotate key'), {
      name: 'AI_NoObjectGeneratedError',
    });
  }
});

test('a failed model call rejects', async () => {
  // Arrange
  using database = contract();
  const failing = new MultiQueryRetriever({
    retriever: keywords(database),
    model: new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The model is down');
      },
    }),
  });

  // Act and Assert
  await assert.rejects(failing.retrieve('rotate key'), {
    message: 'The model is down',
  });
});

test('a queryCount that is not a positive integer is refused', () => {
  // Arrange
  using database = contract();

  // Act and Assert
  for (const queryCount of [0, 1.5]) {
    assert.throws(
      () =>
        new MultiQueryRetriever({
          retriever: keywords(database),
          model: languageModel(queries()),
          queryCount,
        }),
      {
        name: 'RangeError',
        message: `The queryCount is a positive integer, not ${queryCount}`,
      },
    );
  }
});

test("the model writes 4 versions of the query with Haystack's prompt, each version and the query are searched, and reciprocal rank fusion gives the best topK", async () => {
  // Arrange
  using database = contract();
  const calls: Call[] = [];
  const retriever = new MultiQueryRetriever({
    retriever: keywords(database),
    model: languageModel(
      queries(
        'revoke token',
        'renew certificate',
        'expire session',
        'reset password',
      ),
      calls,
    ),
  });

  // Act
  const results = (await retriever.retrieve('  rotate key ', { topK: 4 }))
    .passages;

  // Assert: each of the 5 lists has one passage at rank 1, 1 / (60 + 1), and
  // the list of the query comes first.
  assert.deepEqual(
    calls.map(({ prompt }) => prompt),
    [haystackPrompt(4, 'rotate key')],
  );
  assert.deepEqual(scores(results), [
    ['alpha', 1 / 61],
    ['beta', 1 / 61],
    ['gamma', 1 / 61],
    ['delta', 1 / 61],
  ]);
});

test('the versions past queryCount are cut, a version equal to the query is searched once, and the fusion that the caller gives fuses the lists', async () => {
  // Arrange
  using database = contract();
  const calls: Call[] = [];
  const retriever = new MultiQueryRetriever({
    retriever: keywords(database),
    model: languageModel(
      queries(
        'ROTATE KEY',
        'revoke token',
        'renew certificate',
        'expire session',
      ),
      calls,
    ),
    queryCount: 3,
    fusion: new ScoreFusion({ normalizer: minMax(), combination: sum() }),
  });

  // Act
  const results = (await retriever.retrieve('rotate key')).passages;

  // Assert: the lists of 'rotate key', 'revoke token' and 'renew
  // certificate'; a list of one passage gives it 1 in relative score fusion,
  // and alpha would have 2 if 'ROTATE KEY' were searched too.
  assert.deepEqual(
    calls.map(({ prompt }) => prompt),
    [haystackPrompt(3, 'rotate key')],
  );
  assert.deepEqual(scores(results), [
    ['alpha', 1],
    ['beta', 1],
    ['gamma', 1],
  ]);
});

test('a query bundle is searched as the caller gives it, first, and each version as a plain string; the model and the check of the versions read its query', async () => {
  // Arrange
  const calls: Call[] = [];
  const source = new RecordingRetriever(['alpha']);
  const retriever = new MultiQueryRetriever({
    retriever: source,
    model: languageModel(
      queries('ROTATE KEY', 'revoke token', 'renew certificate'),
      calls,
    ),
    queryCount: 3,
  });
  const query = {
    query: 'rotate key',
    keywords: ['rotate', 'signing', 'key'],
    customEmbeddings: ['To rotate a key, create a new one.'],
  } as const;

  // Act
  await retriever.retrieve(query);

  // Assert: 'ROTATE KEY' is the query in other case, so it is not searched.
  assert.deepEqual(
    calls.map(({ prompt }) => prompt),
    [haystackPrompt(3, 'rotate key')],
  );
  assert.deepEqual(source.queries, [
    query,
    'revoke token',
    'renew certificate',
  ]);
});

test("the filter and includeVectors of the call reach each search, its abort signal reaches the model, and each search gets a signal that aborts when the call's aborts, with its reason", async () => {
  // Arrange
  using database = contract();
  const calls: Call[] = [];
  const given = new AbortController();
  const reason = new Error('the turn ended');
  const signals: (AbortSignal | undefined)[] = [];
  const embeddings: Record<string, readonly number[]> = Object.fromEntries(
    rows.map(({ text, vector }) => [text, vector]),
  );
  const meaning = new SqliteEmbeddingRetriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    vectors: 'docs_passage_vectors',
    model: embeddingModel(embeddings, { signals }),
  });
  const retriever = new MultiQueryRetriever({
    retriever: meaning,
    model: languageModel(queries('revoke token', 'renew certificate'), calls),
    queryCount: 2,
  });

  // Act
  const results = (
    await retriever.retrieve('rotate key', {
      topK: 2,
      filter: { field: 'metadata.product', operator: '==', value: 'a' },
      includeVectors: true,
      signal: given.signal,
    })
  ).passages;

  // Assert: each search gives topK 2 passages. The filter takes beta out of
  // the list of 'revoke token', where alpha, delta, eps and gamma tie at
  // cosine 0 and the smaller ids come first.
  //   'rotate key'        [alpha 1, delta 0]
  //   'revoke token'      [alpha 0, delta 0]
  //   'renew certificate' [gamma 1, alpha 0]
  //   alpha = 1 / 61 + 1 / 61 + 1 / 62, delta = 1 / 62 + 1 / 62, gamma = 1 / 61
  given.abort(reason);
  assert.equal(calls[0]?.abortSignal, given.signal);
  assert.equal(signals.length, 3);
  for (const signal of signals) {
    assert.equal(signal?.aborted, true);
    assert.equal(signal?.reason, reason);
  }
  assert.deepEqual(
    results.map(({ passage, score, vector }) => [passage.id, score, vector]),
    [
      ['alpha', 1 / 61 + 1 / 61 + 1 / 62, [1, 0, 0, 0]],
      ['delta', 1 / 62 + 1 / 62, [0, 0, 0, 1]],
    ],
  );
});

test('ten passages come back when the call gives no topK', async () => {
  // Arrange: twelve passages, each matched by one query of twelve.
  const topics = Array.from({ length: 12 }, (_, index) => `topic${index}`);
  using database = contract(
    topics.map((topic) => ({ id: topic, text: topic, vector: [1, 0, 0, 0] })),
  );
  const retriever = new MultiQueryRetriever({
    retriever: keywords(database),
    model: languageModel(queries(...topics.slice(1))),
    queryCount: 11,
  });

  // Act
  const results = (await retriever.retrieve('topic0')).passages;

  // Assert: each of the 12 lists has one passage at rank 1, in the order of
  // the queries.
  assert.deepEqual(
    scores(results),
    topics.slice(0, 10).map((topic) => [topic, 1 / 61]),
  );
});

test('the failures of the searches merge by name, in the order of the searches, and a name that two searches give keeps the failure of the first', async () => {
  // Arrange: a host fusion that names the children it could not reach; the
  // query and the second version reach no news, and the first version no
  // wiki.
  const first = new RetrieverUnavailableError('news: HTTP 503');
  const wiki = new RetrieverUnavailableError('wiki: HTTP 429');
  const second = new RetrieverUnavailableError('news: timeout');
  const failures = new Map<
    string,
    ReadonlyMap<string, RetrieverUnavailableError>
  >([
    ['rotate key', new Map([['news', first]])],
    ['revoke token', new Map([['wiki', wiki]])],
    ['renew certificate', new Map([['news', second]])],
  ]);
  const federation = {
    retrieve: async (query: QueryType): Promise<RetrievalResult<Passage>> => {
      const text = typeof query === 'string' ? query : query.query;
      return {
        passages: [{ passage: { id: text, text, metadata: {} } }],
        failures: failures.get(text) ?? new Map(),
      };
    },
  };
  const retriever = new MultiQueryRetriever({
    retriever: federation,
    model: languageModel(queries('revoke token', 'renew certificate')),
    queryCount: 2,
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert
  assert.deepEqual(
    [...result.failures],
    [
      ['news', first],
      ['wiki', wiki],
    ],
  );
  assert.equal(result.failures.get('news'), first);
});

test('a search that throws aborts the signal of the other searches, with the error as the reason, and the call rejects with it at once, a RetrieverUnavailableError too: every version reads one retriever', async () => {
  // Arrange: the version 'revoke token' cannot reach the source, and the
  // other searches record their signal and never settle.
  const down = new RetrieverUnavailableError('HTTP 503');
  const signals: (AbortSignal | undefined)[] = [];
  const searching = Promise.withResolvers<void>();
  const source = {
    retrieve: (
      query: QueryType,
      options: RetrieveOptions<Passage> = {},
    ): Promise<RetrievalResult<Passage>> => {
      if (query === 'revoke token') {
        searching.resolve();
        return Promise.reject(down);
      }
      signals.push(options.signal);
      return new Promise(() => {});
    },
  };
  const retriever = new MultiQueryRetriever({
    retriever: source,
    model: languageModel(queries('revoke token', 'renew certificate')),
    queryCount: 2,
  });

  // Act
  const call = retriever.retrieve('rotate key');
  await searching.promise;
  const outcome = await settledThisTurn(call);

  // Assert: the query and 'renew certificate' were searching.
  assert.equal(outcome, down);
  assert.equal(signals.length, 2);
  for (const signal of signals) {
    assert.equal(signal?.aborted, true);
    assert.equal(signal?.reason, down);
  }
});

test("the caller's abort rejects the call at once with the signal's reason, while the searches ignore their signal", async () => {
  // Arrange
  const caller = new AbortController();
  const reason = new Error('the turn ended');
  const searching = Promise.withResolvers<void>();
  const deaf = {
    retrieve: (): Promise<RetrievalResult<Passage>> => {
      searching.resolve();
      return new Promise(() => {});
    },
  };
  const retriever = new MultiQueryRetriever({
    retriever: deaf,
    model: languageModel(queries('revoke token')),
    queryCount: 1,
  });

  // Act
  const call = retriever.retrieve('rotate key', {
    signal: caller.signal,
  });
  await searching.promise;
  caller.abort(reason);
  const outcome = await settledThisTurn(call);

  // Assert: the searches never settle, so the call settles only by the
  // abort.
  assert.equal(outcome, reason);
});

test('a caller that aborted before the fan-out starts no search, as a FusionRetriever starts no retriever, and the call rejects with its reason', async () => {
  // Arrange: the model ignores the signal and answers.
  const caller = new AbortController();
  const reason = new Error('the turn ended');
  caller.abort(reason);
  const source = new RecordingRetriever(['alpha']);
  const retriever = new MultiQueryRetriever({
    retriever: source,
    model: languageModel(queries('revoke token')),
    queryCount: 1,
  });

  // Act
  // A plain await: the caller is aborted before the call, so the call
  // rejects at once whatever the model does, and no turn of the event loop
  // is raced.
  const outcome = await retriever
    .retrieve('rotate key', { signal: caller.signal })
    .then(
      () => 'answered',
      (rejection: unknown) => rejection,
    );

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(source.queries, []);
});

test("the caller's abort rejects the call at once with the signal's reason, while the model ignores its signal and never answers", async () => {
  // Arrange
  const caller = new AbortController();
  const reason = new Error('the turn ended');
  const writing = Promise.withResolvers<void>();
  const source = new RecordingRetriever(['alpha']);
  const retriever = new MultiQueryRetriever({
    retriever: source,
    model: new MockLanguageModelV4({
      doGenerate: () => {
        writing.resolve();
        return new Promise(() => {});
      },
    }),
    queryCount: 1,
  });

  // Act
  const call = retriever.retrieve('rotate key', { signal: caller.signal });
  await writing.promise;
  caller.abort(reason);
  const outcome = await settledThisTurn(call);

  // Assert
  assert.equal(outcome, reason);
  assert.deepEqual(source.queries, []);
});

test('the lists fuse as the inputs query, version 1 and version 2, in the order of the searches, each with the weight 1', async () => {
  // Arrange
  const inputs: FusionInput<RankedDoc>[] = [];
  const recording: Fusion<RankedDoc> = {
    fuse: (given) => {
      inputs.push(...given);
      return [];
    },
  };
  const retriever = new MultiQueryRetriever({
    retriever: new RecordingRetriever(['alpha']),
    model: languageModel(queries('revoke token', 'renew certificate')),
    queryCount: 2,
    fusion: recording,
  });

  // Act
  await retriever.retrieve('rotate key');

  // Assert
  assert.deepEqual(
    inputs.map(({ name, weight }) => [name, weight]),
    [
      ['query', 1],
      ['version 1', 1],
      ['version 2', 1],
    ],
  );
});

test('under ScoreFusion(none, max), a passage that two searches find keeps its greatest score, not the sum; the passage is the one of the first search that finds it, and its vector the first that a search gives (#5585)', async () => {
  // Arrange: a host engine that gives each query its own scored passages.
  const found = new Map<string, readonly ScoredPassage[]>([
    [
      'rotate key',
      [
        {
          passage: { id: 'x', text: 'x as the query found it', metadata: {} },
          score: 0.3,
        },
      ],
    ],
    [
      'revoke token',
      [
        {
          passage: { id: 'y', text: 'y', metadata: {} },
          score: 0.5,
          vector: [0, 1],
        },
        {
          passage: { id: 'x', text: 'x as the version found it', metadata: {} },
          score: 0.4,
          vector: [1, 0],
        },
      ],
    ],
  ]);
  const engine = {
    retrieve: async (
      query: QueryType,
    ): Promise<RetrievalResult<Passage, ScoredPassage>> => ({
      passages:
        found.get(typeof query === 'string' ? query : query.query) ?? [],
      failures: new Map(),
    }),
  };
  const retriever = new MultiQueryRetriever({
    retriever: engine,
    model: languageModel(queries('revoke token')),
    queryCount: 1,
    fusion: new ScoreFusion({ normalizer: none(), combination: max() }),
  });

  // Act
  const { passages } = await retriever.retrieve('rotate key');

  // Assert: y = 0.5; x = max(0.3, 0.4) = 0.4, where the sum would be 0.7.
  assert.deepEqual(passages, [
    {
      passage: { id: 'y', text: 'y', metadata: {} },
      score: 0.5,
      vector: [0, 1],
    },
    {
      passage: { id: 'x', text: 'x as the query found it', metadata: {} },
      score: 0.4,
      vector: [1, 0],
    },
  ]);
});

void test.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY], (topK) =>
  test(`a topK of ${topK} in the call is a RangeError before the model or the retriever is called, as Elasticsearch refuses a bad size`, async () => {
    // Arrange
    const calls: Call[] = [];
    const source = new RecordingRetriever(['kw-1']);
    const retriever = new MultiQueryRetriever({
      retriever: source,
      model: languageModel(queries('change a key'), calls),
    });

    // Act
    const call = retriever.retrieve('rotate a key', { topK });

    // Assert
    await assert.rejects(call, {
      name: 'RangeError',
      message: `The topK is a whole number of 0 or more, not ${topK}`,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(source.queries, []);
  }),
);

test("a topK of 0 in the call gives no passages, as Elasticsearch's size 0", async () => {
  // Arrange
  const retriever = new MultiQueryRetriever({
    retriever: new RecordingRetriever(['kw-1']),
    model: languageModel(queries('change a key')),
  });

  // Act
  const result = await retriever.retrieve('rotate a key', { topK: 0 });

  // Assert
  assert.deepEqual(result.passages, []);
});
