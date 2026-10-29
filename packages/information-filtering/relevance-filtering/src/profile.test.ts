import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection, UnknownDocumentError } from '@zukhruf/embeddings';

import {
  type Article,
  CalibratedFilter,
  ConflictingAnswerError,
  KeywordFilter,
  MissingVectorError,
  NoEvidenceError,
  Profile,
  UnknownArticleError,
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

// Stores the stream at days 10 to 49 and the taught articles at day 1, and
// gives the stream in the order of the angles.
async function stored(
  database: DatabaseSync,
  stream: readonly { id: string; degrees: number; text: string }[],
  taught: ReadonlyMap<string, number> = new Map(),
): Promise<{ collection: Collection; articles: [Article, ...Article[]] }> {
  const angles = new Map([
    ...stream.map(({ id, degrees }) => [id, degrees] as const),
    ...taught,
  ]);
  const collection = new Collection({ database, model: model(angles) });
  const articles = stream.map(({ id, text }, index) => ({
    id,
    publishedAt: day(10 + index),
    text,
  }));
  await collection.upsert([
    ...articles.map(({ id, publishedAt }) => ({ id, text: id, publishedAt })),
    ...[...taught.keys()].map((id) => ({ id, text: id, publishedAt: day(1) })),
  ]);
  const [first, ...rest] = articles;
  if (first === undefined) throw new Error('The test needs a stream.');
  return { collection, articles: [first, ...rest] };
}

const noText = (id: string): string => {
  throw new Error(`The filter asked for the text of ${id}`);
};

describe('Profile', () => {
  test('with gives a corrected copy and leaves the profile as it was', () => {
    const profile = new Profile({
      name: 'security',
      description: 'Attacks and breaches.',
      relevant: ['a'],
      notRelevant: ['b'],
    });

    const corrected = profile.with({
      relevant: ['a', 'c'],
      keywords: ['secur'],
    });

    assert.deepEqual(
      [
        corrected.name,
        corrected.relevant,
        corrected.notRelevant,
        corrected.keywords,
      ],
      ['security', ['a', 'c'], ['b'], ['secur']],
    );
    assert.deepEqual([profile.relevant, profile.keywords], [['a'], []]);
    assert.ok(Object.isFrozen(profile.relevant));
  });

  test('an article that is both a relevant and a not-relevant answer is a ConflictingAnswerError, also in a correction', () => {
    const fields = { name: 'jobs', description: 'Jobs.', notRelevant: ['x'] };

    assert.throws(
      () => new Profile({ ...fields, relevant: ['x'] }),
      (error) => error instanceof ConflictingAnswerError && error.id === 'x',
    );
    assert.throws(
      () => new Profile({ ...fields, relevant: [] }).with({ relevant: ['x'] }),
      ConflictingAnswerError,
    );
  });
});

describe('train', () => {
  test('the probabilities, the binormal fit and the accepted articles are those of the research code (round 2 and round 6) on the stored vectors', async () => {
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
    const profile = new Profile({
      name: 'security',
      description: 'Attacks and breaches.',
      keywords: ['secur'],
      relevant: ['yes-4', 'yes-8', 'yes-12'],
      notRelevant: ['no-50', 'no-70', 'no-80'],
    });

    const filter = profile.train({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: (id) => (id === 'yes-4' ? 'A security flaw' : 'A new chip'),
    });

    assert.ok(filter instanceof CalibratedFilter);
    assert.equal(filter.calibration.method, 'binormal');
    if (filter.calibration.method === 'binormal') {
      const { share, relevant, other } = filter.calibration;
      for (const [actual, expected] of [
        [share, 0.17634588516589259],
        [relevant.mean, 1.1423023873459672],
        [relevant.sd, 0.05],
        [other.mean, -0.2965517533647341],
        [other.sd, 0.933638351160072],
      ] as const)
        assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ${expected}`);
    }
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
      assert.ok(Math.abs(filter.probability(id) - probability) < 1e-12, id);
    assert.deepEqual(filter.accepted(), [
      's30',
      's0',
      's14',
      's7',
      's37',
      's23',
      's21',
    ]);
    assert.equal(filter.threshold, filter.probability('s21'));
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

    const filter = new Profile({
      name: 'topic',
      description: 'A topic.',
      relevant: ['yes'],
      notRelevant: ['no'],
    }).train({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: noText,
    });

    const probabilities = articles
      .map(({ id }) => filter.probability(id))
      .toSorted((a, b) => b - a);
    const total = probabilities.reduce((sum, p) => sum + p, 0);
    const expectedF = probabilities.map(
      (_, index) =>
        (1.25 *
          probabilities.slice(0, index + 1).reduce((sum, p) => sum + p, 0)) /
        (0.25 * total + index + 1),
    );
    const best = expectedF.indexOf(Math.max(...expectedF)) + 1;
    assert.equal(filter.accepted().length, best);
    assert.ok(best > 0 && best < articles.length);
    assert.ok(
      filter.accepted().every((id) => filter.accepts(id)) &&
        articles.filter(({ id }) => filter.accepts(id)).length === best,
    );
  });

  test('a keyword match raises the probability of an article above an equally similar article without one', async () => {
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
    const fields = {
      name: 'security',
      description: 'Attacks and breaches.',
      relevant: ['yes'],
      notRelevant: ['no'],
    };
    const options = {
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: () => 'Security flaw found',
    };

    const withKeyword = new Profile({ ...fields, keywords: ['secur'] }).train(
      options,
    );
    const without = new Profile(fields).train(options);

    assert.ok(withKeyword.probability('s0') > withKeyword.probability('s1'));
    assert.equal(without.probability('s0'), without.probability('s1'));
  });

  test('a profile with no relevant answer accepts the articles that match a keyword at the start of a word, in any case', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'title', degrees: 80, text: 'SECURITY firms merge' },
      { id: 'inside', degrees: 0, text: 'A cybersecurity startup' },
      { id: 'word', degrees: 0, text: 'Firms are securing data' },
      { id: 'none', degrees: 0, text: 'Chips are cheaper' },
      { id: 'pattern', degrees: 0, text: 'A new ransomware strain' },
    ]);
    const profile = new Profile({
      name: 'security',
      description: 'Attacks and breaches.',
      keywords: ['secur', /ransom/u],
      relevant: [],
      notRelevant: ['none'],
    });

    const filter = profile.train({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: noText,
    });

    assert.ok(filter instanceof KeywordFilter);
    assert.deepEqual(filter.accepted(), ['title', 'word', 'pattern']);
    assert.deepEqual(
      articles.map(({ id }) => filter.probability(id)),
      [1, 0, 1, 0, 1],
    );
  });

  test('a calibrated filter ranks the stream by probability, and equal vectors by id', async () => {
    using database = new DatabaseSync(':memory:');
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

    const filter = new Profile({
      name: 'topic',
      description: 'A topic.',
      relevant: ['yes'],
      notRelevant: ['no'],
    }).train({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: noText,
    });

    const ranked = filter.ranked();
    assert.deepEqual(ranked.slice(0, 3), ['near', 'twin-a', 'twin-b']);
    assert.equal(ranked.length, articles.length);
    assert.ok(
      ranked.every(
        (id, index) =>
          index === 0 ||
          filter.probability(ranked[index - 1] ?? id) >= filter.probability(id),
      ),
    );
  });

  test('a keyword filter ranks the matches first, the newest first, then the other articles by similarity, and a range keeps that order for its days', async () => {
    using database = new DatabaseSync(':memory:');
    // stored() gives article n the publish day 10 + n.
    const { collection, articles } = await stored(database, [
      { id: 'old-match', degrees: 0, text: 'Security news' },
      { id: 'far', degrees: 80, text: 'Markets' },
      { id: 'new-match', degrees: 60, text: 'Securing data' },
      { id: 'near', degrees: 5, text: 'Chips' },
    ]);

    const filter = new Profile({
      name: 'security',
      description: 'Attacks and breaches.',
      keywords: ['secur'],
      relevant: [],
      notRelevant: [],
    }).train({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: noText,
    });

    assert.deepEqual(filter.ranked(), [
      'new-match',
      'old-match',
      'near',
      'far',
    ]);
    assert.deepEqual(filter.ranked({ from: day(10), to: day(11) }), [
      'old-match',
      'far',
    ]);
  });

  test('a profile with no relevant answer and no keyword is a NoEvidenceError', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'a', degrees: 0, text: 'A' },
    ]);
    const profile = new Profile({
      name: 'empty',
      description: 'Something.',
      relevant: [],
      notRelevant: ['a'],
    });

    assert.throws(
      () =>
        profile.train({
          vectors: collection,
          descriptionVector: DESCRIPTION,
          stream: articles,
          taughtText: noText,
        }),
      NoEvidenceError,
    );
  });

  test('when the stream scores cannot hold a binormal fit, Platt calibrates on the answers, or the keywords decide when no answer is a no', async () => {
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
    const profile = new Profile({
      name: 'security',
      description: 'Attacks and breaches.',
      keywords: ['secur'],
      relevant: ['yes-1', 'yes-2'],
      notRelevant: ['no-1', 'no-2'],
    });
    const options = {
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: () => 'Security',
    };

    const platt = profile.train(options);
    const reversed = profile
      .with({ relevant: ['no-1', 'no-2'], notRelevant: ['yes-1', 'yes-2'] })
      .train(options);
    const keywords = profile.with({ notRelevant: [] }).train(options);

    assert.ok(platt instanceof CalibratedFilter);
    assert.equal(platt.calibration.method, 'platt');
    assert.ok(reversed instanceof CalibratedFilter);
    assert.equal(reversed.calibration.method, 'constant');
    assert.ok(keywords instanceof KeywordFilter);
    assert.deepEqual(keywords.accepted(), ['a', 'b', 'c']);
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
    const train = (stream: [Article, ...Article[]]) =>
      new Profile({
        name: 'topic',
        description: 'A topic.',
        relevant: ['yes'],
        notRelevant: [],
      }).train({
        vectors: collection,
        descriptionVector: DESCRIPTION,
        stream,
        taughtText: noText,
      });

    assert.throws(
      () =>
        train([...articles, { id: 'missing', publishedAt: day(11), text: '' }]),
      (error) => error instanceof MissingVectorError && error.id === 'missing',
    );
    assert.throws(
      () => train([{ ...articles[0], publishedAt: day(30) }]),
      (error) => error instanceof MissingVectorError && error.id === 'a',
    );
  });

  test('a stream with one id two times is a RangeError', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'a', degrees: 0, text: 'Security' },
    ]);

    assert.throws(
      () =>
        new Profile({
          name: 'security',
          description: 'Attacks and breaches.',
          keywords: ['secur'],
          relevant: [],
          notRelevant: [],
        }).train({
          vectors: collection,
          descriptionVector: DESCRIPTION,
          stream: [...articles, ...articles],
          taughtText: noText,
        }),
      RangeError,
    );
  });

  test('a taught article that the vectors do not hold fails with the error of the vectors', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'a', degrees: 0, text: 'A' },
    ]);
    const vectors: Vectors = collection;

    assert.throws(
      () =>
        new Profile({
          name: 'topic',
          description: 'A topic.',
          relevant: ['gone'],
          notRelevant: [],
        }).train({
          vectors,
          descriptionVector: DESCRIPTION,
          stream: articles,
          taughtText: noText,
        }),
      (error) => error instanceof UnknownDocumentError && error.id === 'gone',
    );
  });

  test('a question about an article that is not in the stream is an UnknownArticleError', async () => {
    using database = new DatabaseSync(':memory:');
    const { collection, articles } = await stored(database, [
      { id: 'a', degrees: 0, text: 'Security' },
    ]);
    const filter = new Profile({
      name: 'security',
      description: 'Attacks and breaches.',
      keywords: ['secur'],
      relevant: [],
      notRelevant: [],
    }).train({
      vectors: collection,
      descriptionVector: DESCRIPTION,
      stream: articles,
      taughtText: noText,
    });

    assert.throws(
      () => filter.probability('other'),
      (error) => error instanceof UnknownArticleError && error.id === 'other',
    );
    assert.throws(() => filter.accepts('other'), UnknownArticleError);
  });
});
