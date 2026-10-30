import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection, UnknownDocumentError } from '@zukhruf/embeddings';

import {
  type Answer,
  ExpectedFThreshold,
  MissingVectorError,
  SimilarityScorer,
  type Stream,
  TaughtAnswers,
  UnknownArticleError,
  type Vectors,
} from './index.ts';

// A signal that no test aborts.
const running = new AbortController().signal;

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

// Stores the stream at days 10 to 49 and the taught articles at day 1, and
// gives the stream in the order of the angles.
async function stored(
  database: DatabaseSync,
  stream: readonly { id: string; degrees: number; text: string }[],
  taught: ReadonlyMap<string, number> = new Map(),
): Promise<{ collection: Collection; articles: Stream }> {
  const angles = new Map([
    ...stream.map(({ id, degrees }) => [id, degrees] as const),
    ...taught,
  ]);
  const collection = new Collection({ database, model: model(angles) });
  const articles = new Map(
    stream.map(({ id, text }, index) => [
      id,
      { publishedAt: day(10 + index), text },
    ]),
  );
  await collection.upsert([
    ...[...articles].map(([id, { publishedAt }]) => ({
      id,
      text: id,
      publishedAt,
    })),
    ...[...taught.keys()].map((id) => ({ id, text: id, publishedAt: day(1) })),
  ]);
  return { collection, articles };
}

// The reader's answers, each with the text of its article. The test names
// at least one yes answer.
function answers(
  yes: readonly (readonly [string, string])[],
  no: readonly string[] = [],
): TaughtAnswers {
  const taught = TaughtAnswers.parse(
    new Map<string, Answer>([
      ...yes.map(([id, text]) => [id, { relevant: true, text }] as const),
      ...no.map((id) => [id, { relevant: false, text: '' }] as const),
    ]),
  );
  if (taught === undefined) throw new Error('The test needs a yes answer.');
  return taught;
}

const expectedF05 = new ExpectedFThreshold({ beta: 0.5 });

describe('SimilarityScorer', () => {
  test('the probabilities and the accepted articles are those of the research code (round 2 and round 6) on the stored vectors', async () => {
    using database = new DatabaseSync(':memory:');
    // The angles, matches and answers of the reference that the research
    // code computed (round-2 evaluate.py binormal and plugin_threshold, and
    // round-6 with_keyword) on float32 unit vectors, as a collection stores
    // them.
    const angles = [
      3, 40, 77, 29, 66, 18, 55, 7, 44, 81, 33, 70, 22, 59, 11, 48, 85, 37, 74,
      26, 63, 15, 52, 4, 41, 78, 30, 67, 19, 56, 8, 45, 82, 34, 71, 23, 60, 12,
      49, 86,
    ];
    const { collection, articles } = await stored(
      database,
      angles.map((degrees, index) => ({
        id: `s${index}`,
        degrees,
        text: index % 5 === 0 ? 'Security update' : 'Market news',
      })),
      new Map([
        ['yes-4', 4],
        ['yes-8', 8],
        ['yes-12', 12],
        ['no-50', 50],
        ['no-70', 70],
        ['no-80', 80],
      ]),
    );

    const scores = await new SimilarityScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      answers: answers(
        [
          ['yes-4', 'A security flaw'],
          ['yes-8', 'A new chip'],
          ['yes-12', 'A new chip'],
        ],
        ['no-50', 'no-70', 'no-80'],
      ),
      keywords: ['secur'],
    }).score(articles, { signal: running });

    const expected = new Map([
      ['s0', 0.9439102938642018],
      ['s5', 0.6115806755281108],
      ['s7', 0.900429088684384],
      ['s12', 0.003993846563405956],
      ['s14', 0.9062000866707524],
      ['s19', 3.2370919639257423e-7],
      ['s21', 0.8037315956097226],
      ['s23', 0.8796608710476925],
      ['s28', 0.19996375567324393],
      ['s30', 0.9590859722242034],
      ['s35', 0.0014838514131620961],
      ['s37', 0.8979714182377918],
    ]);
    for (const [id, probability] of expected)
      assert.ok(Math.abs(scores.probability(id) - probability) < 1e-12, id);
    assert.deepEqual(scores.accepted(expectedF05), [
      's30',
      's0',
      's14',
      's7',
      's37',
      's23',
      's21',
    ]);
    assert.equal(expectedF05.cut(scores), scores.probability('s21'));
  });

  test('the accepted articles are the m most probable articles that maximise the expected F0.5', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(
      database,
      Array.from({ length: 30 }, (_, index) => ({
        id: `s${index}`,
        degrees: (index * 23) % 80,
        text: 'News',
      })),
      new Map([
        ['yes', 5],
        ['no', 60],
      ]),
    );

    const scores = await new SimilarityScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      answers: answers([['yes', 'News']], ['no']),
      keywords: [],
    }).score(articles, { signal: running });

    const probabilities = [...articles.keys()]
      .map((id) => scores.probability(id))
      .toSorted((a, b) => b - a);
    const total = probabilities.reduce((sum, p) => sum + p, 0);
    const expectedF = probabilities.map(
      (_, index) =>
        (1.25 *
          probabilities.slice(0, index + 1).reduce((sum, p) => sum + p, 0)) /
        (0.25 * total + index + 1),
    );
    const best = expectedF.indexOf(Math.max(...expectedF)) + 1;
    const accepted = scores.accepted(expectedF05);
    assert.equal(accepted.length, best);
    assert.ok(best > 0 && best < articles.size);
    assert.deepEqual(
      accepted.map((id) => scores.probability(id)),
      probabilities.slice(0, best),
    );
  });

  test('a keyword that the yes answers match raises the probability of an article above an equally similar article without the keyword', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(
      database,
      Array.from({ length: 30 }, (_, index) => ({
        id: `s${index}`,
        degrees: index < 2 ? 10 : 20 + index * 2,
        text: index === 0 ? 'Securing the grid' : 'Markets',
      })),
      new Map([
        ['yes', 8],
        ['no', 70],
      ]),
    );
    const taught = answers([['yes', 'Security flaw found']], ['no']);
    const scorer = (keywords: readonly string[]) =>
      new SimilarityScorer({
        vectors: collection,
        descriptionVector: DESCRIPTION,
        answers: taught,
        keywords,
      });

    const withKeyword = await scorer(['secur']).score(articles, {
      signal: running,
    });
    const without = await scorer([]).score(articles, { signal: running });

    assert.ok(withKeyword.probability('s0') > withKeyword.probability('s1'));
    assert.equal(without.probability('s0'), without.probability('s1'));
  });

  test('ranks the stream by probability, equal vectors by id, and a range keeps that order for its days', async () => {
    using database = new DatabaseSync(':memory:');
    // stored() gives article n the publish day 10 + n.
    const { collection, articles } = await stored(
      database,
      [
        { id: 'far', degrees: 70, text: 'News' },
        { id: 'twin-b', degrees: 12, text: 'News' },
        { id: 'near', degrees: 3, text: 'News' },
        { id: 'twin-a', degrees: 12, text: 'News' },
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `s${index}`,
          degrees: 30 + index * 2,
          text: 'News',
        })),
      ],
      new Map([
        ['yes', 5],
        ['no', 60],
      ]),
    );

    const scores = await new SimilarityScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      answers: answers([['yes', 'News']], ['no']),
      keywords: [],
    }).score(articles, { signal: running });

    const ranked = scores.ranked();
    assert.deepEqual(ranked.slice(0, 3), ['near', 'twin-a', 'twin-b']);
    assert.equal(ranked.length, articles.size);
    assert.ok(
      ranked.every(
        (id, index) =>
          index === 0 ||
          scores.probability(ranked[index - 1] ?? id) >= scores.probability(id),
      ),
    );
    assert.deepEqual(scores.ranked({ from: day(10), to: day(13) }), [
      'near',
      'twin-a',
      'twin-b',
      'far',
    ]);
  });

  test('when the stream scores cannot hold a binormal fit, Platt calibrates on the answers, a constant probability stands in when the answers rank backwards, and the keyword matches come first when no answer is a no', async () => {
    using database = new DatabaseSync(':memory:');
    // Every stream article has one similarity, so the scores have no spread.
    const { collection, articles } = await stored(
      database,
      ['a', 'b', 'c'].map((id) => ({
        id,
        degrees: 30,
        text: `Security ${id}`,
      })),
      new Map([
        ['yes-1', 5],
        ['yes-2', 10],
        ['no-1', 60],
        ['no-2', 70],
      ]),
    );
    const scorer = (taught: TaughtAnswers) =>
      new SimilarityScorer({
        vectors: collection,
        descriptionVector: DESCRIPTION,
        answers: taught,
        keywords: ['secur'],
      });

    const platt = await scorer(
      answers(
        [
          ['yes-1', 'Security'],
          ['yes-2', 'Security'],
        ],
        ['no-1', 'no-2'],
      ),
    ).score(articles, { signal: running });
    const reversed = await scorer(
      answers(
        [
          ['no-1', 'Security'],
          ['no-2', 'Security'],
        ],
        ['yes-1', 'yes-2'],
      ),
    ).score(articles, { signal: running });
    const onlyYes = await scorer(
      answers([
        ['yes-1', 'Security'],
        ['yes-2', 'Security'],
      ]),
    ).score(articles, { signal: running });

    // Every stream article and every relevant answer match the keyword, so
    // the keyword evidence multiplies the odds by
    // P(match | relevant) / P(match | stream) = (3/4) / (4/5) = 0.9375.
    // Platt: the research code (round-2 evaluate.py platt_fit and
    // platt_apply) on the float32 similarities gives a = -3.751, b = 2.658
    // and p = 0.6435 before the evidence. Backwards answers: each article
    // gets the mean smoothed target, 0.5.
    for (const id of articles.keys()) {
      assert.ok(
        Math.abs(platt.probability(id) - 0.6285610115091318) < 1e-9,
        id,
      );
      assert.ok(
        Math.abs(reversed.probability(id) - 0.9375 / 1.9375) < 1e-12,
        id,
      );
      assert.equal(onlyYes.probability(id), 1);
    }
    assert.deepEqual(onlyYes.accepted(expectedF05), ['c', 'b', 'a']);
  });

  test('when the fit cannot hold, no answer is a no and there is no keyword, the stream is ranked by similarity, with no error', async () => {
    using database = new DatabaseSync(':memory:');
    // The yes answer is less similar than the whole stream, so the relevant
    // mean is below the other mean and the binormal fit cannot hold.
    const { collection, articles } = await stored(
      database,
      [
        { id: 'middle', degrees: 30, text: 'A' },
        { id: 'near', degrees: 10, text: 'B' },
        { id: 'far', degrees: 50, text: 'C' },
      ],
      new Map([['yes', 85]]),
    );

    const scores = await new SimilarityScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      answers: answers([['yes', 'D']]),
      keywords: [],
    }).score(articles, { signal: running });

    assert.deepEqual(scores.ranked(), ['near', 'middle', 'far']);
  });

  test('the length of the description vector does not change the probabilities: a scorer reads its direction only', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(
      database,
      [
        { id: 'a', degrees: 10, text: 'A' },
        { id: 'b', degrees: 30, text: 'B' },
        { id: 'c', degrees: 50, text: 'C' },
        { id: 'd', degrees: 70, text: 'D' },
        { id: 'e', degrees: 20, text: 'E' },
      ],
      new Map([
        ['yes', 5],
        ['no', 60],
      ]),
    );
    const scored = (descriptionVector: readonly number[]) =>
      new SimilarityScorer({
        vectors: collection,
        descriptionVector,
        answers: answers([['yes', 'A']], ['no']),
        keywords: [],
      }).score(articles, { signal: running });

    const unit = await scored([1, 0]);
    const long = await scored([2, 0]);

    for (const id of articles.keys())
      assert.equal(long.probability(id), unit.probability(id), id);
    assert.ok(unit.probability('a') > 0.5);
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

    const scores = await new SimilarityScorer({
      vectors: unread,
      descriptionVector: DESCRIPTION,
      answers: answers([['yes', 'A']]),
      keywords: ['a'],
    }).score(new Map(), { signal: running });

    assert.deepEqual(scores.ranked(), []);
  });

  test('a stream article that the vectors do not hold with its publish date is a MissingVectorError', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(
      database,
      [
        { id: 'a', degrees: 0, text: 'A' },
        { id: 'b', degrees: 10, text: 'B' },
      ],
      new Map([['yes', 0]]),
    );
    const scorer = new SimilarityScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      answers: answers([['yes', 'A']]),
      keywords: [],
    });

    await assert.rejects(
      scorer.score(
        new Map([...articles, ['missing', { publishedAt: day(11), text: '' }]]),
        { signal: running },
      ),
      (error) => error instanceof MissingVectorError && error.id === 'missing',
    );
    await assert.rejects(
      scorer.score(new Map([['a', { publishedAt: day(30), text: 'A' }]]), {
        signal: running,
      }),
      (error) => error instanceof MissingVectorError && error.id === 'a',
    );
  });

  test('a taught article that the vectors do not hold fails with the error of the vectors', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'a', degrees: 0, text: 'A' },
    ]);

    await assert.rejects(
      new SimilarityScorer({
        vectors: collection,
        descriptionVector: DESCRIPTION,
        answers: answers([['gone', 'A']]),
        keywords: [],
      }).score(articles, { signal: running }),
      (error) => error instanceof UnknownDocumentError && error.id === 'gone',
    );
  });

  test('a question about an article that is not in the stream is an UnknownArticleError', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(
      database,
      [{ id: 'a', degrees: 0, text: 'A' }],
      new Map([['yes', 5]]),
    );

    const scores = await new SimilarityScorer({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      answers: answers([['yes', 'A']]),
      keywords: [],
    }).score(articles, { signal: running });

    assert.throws(
      () => scores.probability('other'),
      (error) => error instanceof UnknownArticleError && error.id === 'other',
    );
  });

  test('a stopped score fails with the reason of the signal and reads no vector, also for an empty stream', async () => {
    const reason = new Error('The reader stops.');
    // A vectors port that fails on every call: a scorer that reads it after
    // the stop fails the test with another error.
    const unread: Vectors = {
      query: () => {
        throw new Error('The scorer queried the vectors.');
      },
      fetch: () => {
        throw new Error('The scorer fetched vectors.');
      },
    };

    await assert.rejects(
      new SimilarityScorer({
        vectors: unread,
        descriptionVector: DESCRIPTION,
        answers: answers([['yes', 'A']]),
        keywords: ['a'],
      }).score(new Map([['a', { publishedAt: day(10), text: 'A' }]]), {
        signal: AbortSignal.abort(reason),
      }),
      (error) => error === reason,
    );
    await assert.rejects(
      new SimilarityScorer({
        vectors: unread,
        descriptionVector: DESCRIPTION,
        answers: answers([['yes', 'A']]),
        keywords: ['a'],
      }).score(new Map(), { signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
  });
});
