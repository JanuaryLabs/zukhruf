import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockLanguageModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import { MultiQueryRetriever, relativeScoreFusion } from './index.ts';
import { SqliteBM25Retriever, SqliteEmbeddingRetriever } from './sqlite.ts';
import { embeddingModel } from './testing/embedding-model.ts';

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
// with the passages as its external content, and the passage vectors.
function contract(
  passages: readonly {
    readonly id: string;
    readonly text: string;
    readonly vector: readonly number[];
  }[] = rows,
): DatabaseSync {
  const database = open(':memory:');
  install(database);
  database.exec(`
    CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT) STRICT;
    CREATE VIRTUAL TABLE docs_passages_fts USING fts5(text, content = 'docs_passages');
    CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT;
  `);
  const passage = database.prepare(
    'INSERT INTO docs_passages VALUES (?, ?, 0, 0, ?, ?, ?)',
  );
  const vector = database.prepare(
    `INSERT INTO docs_passage_vectors VALUES (?, ?, 'test/mini (4 dimensions)')`,
  );
  for (const row of passages) {
    passage.run(
      row.id,
      `doc-${row.id}`,
      row.text.length,
      row.text,
      row.id === 'beta' ? 'b' : 'a',
    );
    vector.run(row.id, toSql(Vector.from(row.vector)));
  }
  database.exec(
    `INSERT INTO docs_passages_fts (docs_passages_fts) VALUES ('rebuild')`,
  );
  return database;
}

const keywords = (database: DatabaseSync) =>
  new SqliteBM25Retriever({
    database,
    passages: 'docs_passages',
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
    readonly score: number;
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
  const results = await retriever.retrieve('  rotate key ', { topK: 4 });

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
    fusion: relativeScoreFusion(),
  });

  // Act
  const results = await retriever.retrieve('rotate key');

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

test('the filter and includeVectors of the call reach each search, and its abort signal reaches the model and each search', async () => {
  // Arrange
  using database = contract();
  const calls: Call[] = [];
  const given = new AbortController();
  const signals: (AbortSignal | undefined)[] = [];
  const embeddings: Record<string, readonly number[]> = Object.fromEntries(
    rows.map(({ text, vector }) => [text, vector]),
  );
  const meaning = new SqliteEmbeddingRetriever({
    database,
    passages: 'docs_passages',
    vectors: 'docs_passage_vectors',
    model: embeddingModel(embeddings, { signals }),
  });
  const retriever = new MultiQueryRetriever({
    retriever: meaning,
    model: languageModel(queries('revoke token', 'renew certificate'), calls),
    queryCount: 2,
  });

  // Act
  const results = await retriever.retrieve('rotate key', {
    topK: 2,
    filter: { field: 'metadata.product', operator: '==', value: 'a' },
    includeVectors: true,
    abortSignal: given.signal,
  });

  // Assert: each search gives topK 2 passages. The filter takes beta out of
  // the list of 'revoke token', where alpha, delta, eps and gamma tie at
  // cosine 0 and the smaller ids come first.
  //   'rotate key'        [alpha 1, delta 0]
  //   'revoke token'      [alpha 0, delta 0]
  //   'renew certificate' [gamma 1, alpha 0]
  //   alpha = 1 / 61 + 1 / 61 + 1 / 62, delta = 1 / 62 + 1 / 62, gamma = 1 / 61
  assert.equal(calls[0]?.abortSignal, given.signal);
  assert.deepEqual(signals, [given.signal, given.signal, given.signal]);
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
  const results = await retriever.retrieve('topic0');

  // Assert: each of the 12 lists has one passage at rank 1, in the order of
  // the queries.
  assert.deepEqual(
    scores(results),
    topics.slice(0, 10).map((topic) => [topic, 1 / 61]),
  );
});
