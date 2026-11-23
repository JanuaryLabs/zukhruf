import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockLanguageModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import { HydeRetriever } from './index.ts';
import { SqliteEmbeddingRetriever } from './sqlite.ts';
import { embeddingModel } from './testing/embedding-model.ts';

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
    database,
    passages: 'docs_passages',
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
  const results = await retriever.retrieve('how do I change my signing key?', {
    topK: 1,
    filter: { field: 'metadata.product', operator: '==', value: 'a' },
    includeVectors: true,
  });

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
  await retriever.retrieve('rotate a key', { abortSignal: given.signal });

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
