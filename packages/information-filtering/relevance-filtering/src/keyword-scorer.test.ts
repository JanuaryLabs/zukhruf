import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection } from '@zukhruf/embeddings';

import {
  ExpectedFThreshold,
  KeywordScorer,
  MissingVectorError,
  type Stream,
  type Vectors,
} from './index.ts';

// A real embedding model cannot run in CI. The AI SDK's own mock model stands
// in for it: the text of each document is its id, and the model gives the
// unit vector at the angle that the test names for the id, in degrees. The
// description vector is [1, 0], so the similarity of an article is the
// cosine of its angle.
function model(angles: ReadonlyMap<string, number>): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: Infinity,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((id) => {
        const degrees = angles.get(id);
        if (degrees === undefined)
          throw new Error(`The test names no angle for ${id}`);
        const radians = (degrees * Math.PI) / 180;
        return [Math.cos(radians), Math.sin(radians)];
      }),
      warnings: [],
    }),
  });
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 9, n));
}

const DESCRIPTION = [1, 0];

// Stores the stream at days 10 to 49, in the order of the list.
async function stored(
  database: DatabaseSync,
  stream: readonly { id: string; degrees: number; text: string }[],
): Promise<{ collection: Collection; articles: Stream }> {
  const collection = new Collection({
    database,
    model: model(new Map(stream.map(({ id, degrees }) => [id, degrees]))),
  });
  const articles = new Map(
    stream.map(({ id, text }, index) => [
      id,
      { publishedAt: day(10 + index), text },
    ]),
  );
  await collection.upsert(
    [...articles].map(([id, { publishedAt }]) => ({
      id,
      text: id,
      publishedAt,
    })),
  );
  return { collection, articles };
}

describe('KeywordScorer', () => {
  test('gives the articles that match a keyword at the start of a word, in any case, or a regular expression as it is, the probability 1 and the others 0, and a threshold accepts the matches', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'title', degrees: 80, text: 'SECURITY firms merge' },
      { id: 'inside', degrees: 0, text: 'A cybersecurity startup' },
      { id: 'word', degrees: 0, text: 'Firms are securing data' },
      { id: 'none', degrees: 0, text: 'Chips are cheaper' },
      { id: 'pattern', degrees: 0, text: 'A new ransomware strain' },
    ]);

    const scores = await new KeywordScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      keywords: ['secur', /ransom/u],
    }).score(articles);

    assert.deepEqual(
      [...articles.keys()].map((id) => scores.probability(id)),
      [1, 0, 1, 0, 1],
    );
    assert.deepEqual(scores.accepted(new ExpectedFThreshold({ beta: 0.5 })), [
      'pattern',
      'word',
      'title',
    ]);
  });

  test('ranks the matches first, the newest first, then the other articles by similarity, and a range keeps that order for its days', async () => {
    using database = new DatabaseSync(':memory:');
    // stored() gives article n the publish day 10 + n.
    const { collection, articles } = await stored(database, [
      { id: 'old-match', degrees: 0, text: 'Security news' },
      { id: 'far', degrees: 80, text: 'Markets' },
      { id: 'new-match', degrees: 60, text: 'Securing data' },
      { id: 'near', degrees: 5, text: 'Chips' },
    ]);

    const scores = await new KeywordScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      keywords: ['secur'],
    }).score(articles);

    assert.deepEqual(scores.ranked(), [
      'new-match',
      'old-match',
      'near',
      'far',
    ]);
    assert.deepEqual(scores.ranked({ from: day(11), to: day(13) }), [
      'new-match',
      'near',
      'far',
    ]);
  });

  test('an empty stream gives empty scores and reads no vector', async () => {
    // A vectors port that fails on every call: a scorer that reads it for an
    // empty stream fails the test.
    const unread: Vectors = {
      query: () => {
        throw new Error('The scorer queried the vectors.');
      },
      fetch: () => {
        throw new Error('The scorer fetched vectors.');
      },
    };

    const scores = await new KeywordScorer({
      vectors: unread,
      descriptionVector: DESCRIPTION,
      keywords: ['secur'],
    }).score(new Map());

    assert.deepEqual(scores.ranked(), []);
  });

  test('a stream article that the vectors do not hold with its publish date is a MissingVectorError', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'a', degrees: 0, text: 'Security' },
    ]);

    await assert.rejects(
      new KeywordScorer({
        vectors: collection,
        descriptionVector: DESCRIPTION,
        keywords: ['secur'],
      }).score(
        new Map([...articles, ['missing', { publishedAt: day(10), text: '' }]]),
      ),
      (error) => error instanceof MissingVectorError && error.id === 'missing',
    );
  });
});
