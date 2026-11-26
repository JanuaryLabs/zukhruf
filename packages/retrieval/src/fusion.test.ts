import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import {
  type Combination,
  type FusionInput,
  type ListScores,
  RankFusion,
  type RankNormalizer,
  type RankedDoc,
  type ScoreDoc,
  ScoreFusion,
  type ScoreNormalizer,
  arithmeticMean,
  distributionBased,
  max,
  minMax,
  none,
  reciprocalRank,
  sum,
} from './index.ts';

// The steps that both families share: the weights, the finite output of each
// strategy, the grouping on id and the order.
const families = [
  ['RankFusion', new RankFusion()],
  [
    'ScoreFusion(minMax, sum)',
    new ScoreFusion({ normalizer: minMax(), combination: sum() }),
  ],
  [
    'ScoreFusion(distributionBased, sum)',
    new ScoreFusion({ normalizer: distributionBased(), combination: sum() }),
  ],
] as const;

// An input as a host gives it: its docs best first.
const input = (
  name: string,
  weight: number,
  ...docs: readonly (readonly [string, number])[]
): FusionInput<ScoreDoc> => ({
  name,
  weight,
  docs: docs.map(([id, score]) => ({ id, score })),
});

const scores = (fused: readonly ScoreDoc[]) =>
  fused.map(({ id, score }) => [id, score]);

void test.each(
  families.flatMap(([family, fusion]) =>
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1].map(
      (weight) => ({ family, fusion, weight }),
    ),
  ),
  ({ family, fusion, weight }) =>
    test(`${family} refuses a weight of ${weight} with a RangeError that names its input (#5720)`, () => {
      // Arrange
      const inputs = [
        input('list 0', 1, ['a', 2]),
        input('list 1', weight, ['b', 1]),
      ];

      // Act and Assert
      assert.throws(() => fusion.fuse(inputs), {
        name: 'RangeError',
        message: `The weight of list 1 is a finite number of 0 or more, not ${weight}`,
      });
    }),
);

void test.each(
  families.map(([family, fusion]) => ({ family, fusion })),
  ({ family, fusion }) =>
    test(`${family} refuses weights of which none is above 0 (#5720)`, () => {
      // Arrange
      const inputs = [
        input('list 0', 0, ['a', 2]),
        input('list 1', 0, ['b', 1]),
      ];

      // Act and Assert
      assert.throws(() => fusion.fuse(inputs), {
        name: 'RangeError',
        message:
          'A fusion takes at least one weight above 0: every weight is 0',
      });
    }),
);

void test.each(
  families.map(([family, fusion]) => ({ family, fusion })),
  ({ family, fusion }) =>
    test(`${family} fuses no input into no doc, as there is no weight to be above 0 (#5720)`, () => {
      assert.deepEqual(fusion.fuse([]), []);
    }),
);

void test.each(
  [
    {
      family: 'RankFusion',
      fusion: new RankFusion(),
      expected: [
        { id: 'a', score: 1 / 61 },
        { id: 'b', score: 1 / 62 },
      ],
    },
    {
      family: 'ScoreFusion',
      fusion: new ScoreFusion({ normalizer: minMax(), combination: sum() }),
      expected: [
        { id: 'a', score: 1 },
        { id: 'b', score: 0 },
      ],
    },
  ],
  ({ family, fusion, expected }) =>
    test(`${family} takes an input with no docs beside another, and it adds nothing, as a retriever that gave nothing adds nothing`, () => {
      // Arrange
      const inputs = [
        input('web', 1),
        input('keywords', 1, ['a', 2], ['b', 1]),
      ];

      // Act
      const fused = fusion.fuse(inputs);

      // Assert
      assert.deepEqual(fused, expected);
    }),
);

void test.each(
  [
    {
      name: 'RankFusion()',
      fusion: new RankFusion(),
      expected: [
        { id: 'b', score: 1 / 61 },
        { id: 'c', score: 1 / 62 },
        { id: 'a', score: 0 },
      ],
    },
    {
      name: 'ScoreFusion(minMax, sum)',
      fusion: new ScoreFusion({ normalizer: minMax(), combination: sum() }),
      expected: [
        { id: 'b', score: 1 },
        { id: 'a', score: 0 },
        { id: 'c', score: 0 },
      ],
    },
    // The list [1, 0.5] alone: mean 0.75, σ 0.25, so 0 to 1.5.
    {
      name: 'ScoreFusion(distributionBased, sum)',
      fusion: new ScoreFusion({
        normalizer: distributionBased(),
        combination: sum(),
      }),
      expected: [
        { id: 'b', score: 1 / 1.5 },
        { id: 'c', score: 0.5 / 1.5 },
        { id: 'a', score: 0 },
      ],
    },
    // Under arithmeticMean, b is (0 * 1 + 1 * 1) / (0 + 1): the input of
    // weight 0 adds nothing to the sum of the weights either, and a, held
    // only by it, has a sum of weights of 0, so 0.
    ...(
      [
        ['sum', sum()],
        ['max', max()],
        ['arithmeticMean', arithmeticMean()],
      ] as const
    ).map(([combine, combination]) => ({
      name: `ScoreFusion(none, ${combine})`,
      fusion: new ScoreFusion({ normalizer: none(), combination }),
      expected: [
        { id: 'b', score: 1 },
        { id: 'c', score: 0.5 },
        { id: 'a', score: 0 },
      ],
    })),
  ],
  ({ name, fusion, expected }) =>
    test(`${name} takes a weight of 0 beside a weight above 0: that input adds nothing, and an id that only it holds stays with the score 0 (#5720)`, () => {
      // Arrange
      const inputs = [
        input('zero', 0, ['a', 2], ['b', 1]),
        input('one', 1, ['b', 1], ['c', 0.5]),
      ];

      // Act
      const fused = fusion.fuse(inputs);

      // Assert
      assert.deepEqual(fused, expected);
    }),
);

test('a fusion gives { id, score } best first, and equal fused scores keep the order in which their ids first appear: in input order, then rank order, not by id', () => {
  // Arrange: none and sum keep the raw scores, so q and p tie at 2 within
  // the first input and o, n and z tie at 1 across the inputs. The ties run
  // against the order of their ids (q, p) and with it (n, z), so neither
  // order of the ids gives the first appearance.
  const fusion = new ScoreFusion({ normalizer: none(), combination: sum() });
  const inputs = [
    input('keywords', 1, ['q', 2], ['p', 1], ['o', 1]),
    input('meaning', 1, ['a', 5], ['p', 1], ['q', 0], ['n', 1], ['z', 1]),
  ];

  // Act
  const fused = fusion.fuse(inputs);

  // Assert
  assert.deepEqual(fused, [
    { id: 'a', score: 5 },
    { id: 'q', score: 2 },
    { id: 'p', score: 2 },
    { id: 'o', score: 1 },
    { id: 'n', score: 1 },
    { id: 'z', score: 1 },
  ]);
});

test('a combination is called once for each id, in the order in which the ids first appear (not by id), with the score and weight of each input that holds it, in input order, weight 0 included', () => {
  // Arrange
  const calls: (readonly {
    readonly score: number;
    readonly weight: number;
  }[])[] = [];
  const recording: Combination = {
    combine: (contributions) => {
      calls.push(contributions);
      return contributions.length;
    },
  };
  const fusion = new ScoreFusion({
    normalizer: none(),
    combination: recording,
  });

  // Act
  fusion.fuse([
    input('keywords', 2, ['m', 1], ['z', 2]),
    input('meaning', 0, ['z', 3]),
    input('web', 1, ['a', 4], ['m', 5]),
  ]);

  // Assert
  assert.deepEqual(calls, [
    [
      { score: 1, weight: 2 },
      { score: 5, weight: 1 },
    ],
    [
      { score: 2, weight: 2 },
      { score: 3, weight: 0 },
    ],
    [{ score: 4, weight: 1 }],
  ]);
});

void test.each(
  [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].flatMap(
    (bad) => {
      const scoreNormalizer: ScoreNormalizer = {
        normalize: (score) => (score === 1 ? bad : score),
      };
      const rankNormalizer: RankNormalizer = {
        normalize: (rank) => (rank === 2 ? bad : 1 / rank),
      };
      return [
        {
          family: 'ScoreFusion',
          bad,
          fusion: new ScoreFusion({
            normalizer: scoreNormalizer,
            combination: sum(),
          }),
        },
        {
          family: 'RankFusion',
          bad,
          fusion: new RankFusion({ normalizer: rankNormalizer }),
        },
      ];
    },
  ),
  ({ family, bad, fusion }) =>
    test(`${family} refuses a normalizer that gives ${bad} with a TypeError that names the doc and its input, where the fused list would sort it anywhere`, () => {
      // Arrange: c is the doc of score 1 and of rank 2.
      const inputs = [
        input('keywords', 1, ['a', 2]),
        input('meaning', 1, ['b', 3], ['c', 1]),
      ];

      // Act and Assert
      assert.throws(() => fusion.fuse(inputs), {
        name: 'TypeError',
        message: `The normalizer gave c of meaning the score ${bad}: a normalized score is a finite number`,
      });
    }),
);

void test.each(
  [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].flatMap(
    (bad) => {
      const combination: Combination = {
        combine: (contributions) => (contributions.length === 2 ? bad : 1),
      };
      return [
        {
          family: 'RankFusion',
          bad,
          fusion: new RankFusion({ combination }),
        },
        {
          family: 'ScoreFusion',
          bad,
          fusion: new ScoreFusion({ normalizer: minMax(), combination }),
        },
      ];
    },
  ),
  ({ family, bad, fusion }) =>
    test(`${family} refuses a combination that gives ${bad} with a TypeError that names the id and the inputs that hold it`, () => {
      // Arrange: b is the id that two inputs hold.
      const inputs = [
        input('keywords', 1, ['a', 2], ['b', 1]),
        input('meaning', 1, ['b', 3]),
      ];

      // Act and Assert
      assert.throws(() => fusion.fuse(inputs), {
        name: 'TypeError',
        message: `The combination gave b the score ${bad}, from keywords, meaning: a fused score is a finite number`,
      });
    }),
);

test('reciprocal rank fusion gives each doc the sum of weight / (60 + rank) over the inputs that hold it, with ranks from 1', () => {
  // Arrange: the scores of the inputs play no part, only their order.
  const inputs = [
    input('list 0', 1, ['a', 900], ['b', 800], ['c', 700]),
    input('list 1', 2, ['c', 0.2], ['d', 0.1]),
  ];

  // Act
  const fused = new RankFusion().fuse(inputs);

  // Assert: LangChain's ensemble.ts adds `weight / (rank + this.c)` with rank
  // from 1 and c 60; Elasticsearch's rrf retriever has rank_constant 60.
  //   c = 1 / (60 + 3) + 2 / (60 + 1) = 0.015873 + 0.032787 = 0.048660
  //   d =                2 / (60 + 2) =                       0.032258
  //   a = 1 / (60 + 1)                = 0.016393
  //   b = 1 / (60 + 2)                = 0.016129
  assert.deepEqual(scores(fused), [
    ['c', 1 / 63 + 2 / 61],
    ['d', 2 / 62],
    ['a', 1 / 61],
    ['b', 1 / 62],
  ]);
});

test('reciprocal rank fusion fuses a list of order only beside a scored list by their order, so its docs take their places among the scored ones', () => {
  // Arrange
  const web: FusionInput<RankedDoc> = {
    name: 'web',
    weight: 1,
    docs: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
  };
  const labels = input('labels', 1, ['l1', 0.9], ['l2', 0.1]);

  // Act
  const fused = new RankFusion().fuse([web, labels]);

  // Assert: rank 1 of each list gives 1 / 61, rank 2 1 / 62 and rank 3
  // 1 / 63; a tie keeps the order in which the ids first appear.
  assert.deepEqual(scores(fused), [
    ['p1', 1 / 61],
    ['l1', 1 / 61],
    ['p2', 1 / 62],
    ['l2', 1 / 62],
    ['p3', 1 / 63],
  ]);
});

// The scores and orders that reciprocalRankFusion() and
// reciprocalRankFusion({ k: 1 }) gave on these lists before #5400 replaced
// them, as JavaScript prints each double, so each is exact.
void test.each(
  [
    {
      lists: 'shared ids under unequal weights',
      inputs: [
        input('keywords', 1, ['a', 900], ['b', 800], ['c', 700]),
        input('meaning', 2, ['c', 0.2], ['d', 0.1]),
        input('web', 0.5, ['d', 3], ['a', 3], ['e', 3]),
      ],
      k60: [
        ['c', 0.04865990111891751],
        ['d', 0.04045478582760444],
        ['a', 0.02445795875198308],
        ['b', 0.016129032258064516],
        ['e', 0.007936507936507936],
      ],
      k1: [
        ['c', 1.25],
        ['d', 0.9166666666666666],
        ['a', 0.6666666666666666],
        ['b', 0.3333333333333333],
        ['e', 0.125],
      ],
    },
    {
      lists: 'ties across the lists',
      inputs: [
        input('keywords', 1, ['q', 9], ['p', 8]),
        input('meaning', 1, ['p', 9], ['q', 8]),
      ],
      k60: [
        ['q', 0.03252247488101534],
        ['p', 0.03252247488101534],
      ],
      k1: [
        ['q', 0.8333333333333333],
        ['p', 0.8333333333333333],
      ],
    },
    {
      lists: 'a list of weight 0',
      inputs: [
        input('zero', 0, ['a', 1], ['b', 2]),
        input('meaning', 1.5, ['b', 1], ['c', 5], ['d', 4]),
        input('web', 1, ['e', 2], ['a', 7]),
      ],
      k60: [
        ['b', 0.02459016393442623],
        ['c', 0.024193548387096774],
        ['d', 0.023809523809523808],
        ['e', 0.01639344262295082],
        ['a', 0.016129032258064516],
      ],
      k1: [
        ['b', 0.75],
        ['c', 0.5],
        ['e', 0.5],
        ['d', 0.375],
        ['a', 0.3333333333333333],
      ],
    },
    {
      lists: 'an id twice in one list, which adds from each place',
      inputs: [
        input('keywords', 1, ['a', 3], ['b', 2], ['a', 1]),
        input('meaning', 1, ['b', 5]),
      ],
      k60: [
        ['b', 0.03252247488101534],
        ['a', 0.032266458495966696],
      ],
      k1: [
        ['b', 0.8333333333333333],
        ['a', 0.75],
      ],
    },
  ].flatMap(({ lists, inputs, k60, k1 }) => [
    {
      lists,
      inputs,
      name: 'new RankFusion()',
      fusion: new RankFusion(),
      expected: k60,
    },
    {
      lists,
      inputs,
      name: 'new RankFusion({ normalizer: reciprocalRank({ k: 1 }) })',
      fusion: new RankFusion({ normalizer: reciprocalRank({ k: 1 }) }),
      expected: k1,
    },
  ]),
  ({ lists, inputs, name, fusion, expected }) =>
    test(`${name} gives the scores, to the last bit, and the order that reciprocalRankFusion gave before #5400, on ${lists}`, () => {
      // Act
      const fused = fusion.fuse(inputs);

      // Assert
      assert.deepEqual(scores(fused), expected);
    }),
);

test('RankFusion reads no score, so lists whose scores are NaN or infinite fuse by their order', () => {
  // Arrange
  const inputs = [
    input('web', 1, ['a', Number.NaN], ['b', Number.POSITIVE_INFINITY]),
    input('pubmed', 1, ['b', Number.NEGATIVE_INFINITY], ['c', 1]),
  ];

  // Act
  const fused = new RankFusion().fuse(inputs);

  // Assert
  assert.deepEqual(fused, [
    { id: 'b', score: 1 / 62 + 1 / 61 },
    { id: 'a', score: 1 / 61 },
    { id: 'c', score: 1 / 62 },
  ]);
});

test('RankFusion takes reciprocalRank({ k: 60 }) when only a combination is given, and sum() when only a normalizer is given', () => {
  // Arrange
  const inputs = [
    input('a list', 1, ['a', 0], ['b', 0]),
    input('b list', 1, ['b', 0]),
  ];

  // Act
  const combined = new RankFusion({ combination: max() }).fuse(inputs);
  const normalized = new RankFusion({
    normalizer: reciprocalRank({ k: 1 }),
  }).fuse(inputs);

  // Assert: under max, b keeps its best place, 1 / 61; under sum with k 1,
  // b adds 1 / 3 and 1 / 2.
  assert.deepEqual(combined, [
    { id: 'a', score: 1 / 61 },
    { id: 'b', score: 1 / 61 },
  ]);
  assert.deepEqual(normalized, [
    { id: 'b', score: 1 / 3 + 1 / 2 },
    { id: 'a', score: 1 / 2 },
  ]);
});

test('a rank normalizer gets the rank of each doc counted from 1 and the length of its list', () => {
  // Arrange
  const placed: RankNormalizer = {
    normalize: (rank, length) => rank * 10 + length,
  };
  const inputs = [
    input('keywords', 1, ['a', 0], ['b', 0], ['c', 0]),
    input('meaning', 1, ['d', 0]),
  ];

  // Act
  const fused = new RankFusion({ normalizer: placed }).fuse(inputs);

  // Assert
  assert.deepEqual(fused, [
    { id: 'c', score: 33 },
    { id: 'b', score: 23 },
    { id: 'a', score: 13 },
    { id: 'd', score: 11 },
  ]);
});

void test.each(
  [
    {
      called: 'reciprocalRank()',
      options: {},
      expected: [1 / 61, 1 / 62, 1 / 63],
    },
    {
      called: 'reciprocalRank({ k: 1 })',
      options: { k: 1 },
      expected: [1 / 2, 1 / 3, 1 / 4],
    },
    {
      called: 'reciprocalRank({ k: 7 })',
      options: { k: 7 },
      expected: [1 / 8, 1 / 9, 1 / 10],
    },
  ],
  ({ called, options, expected }) =>
    test(`${called} gives each place 1 / (k + rank), with ranks from 1 and k 60 when absent`, () => {
      // Arrange
      const fusion = new RankFusion({ normalizer: reciprocalRank(options) });

      // Act
      const fused = fusion.fuse([
        input('keywords', 1, ['a', 0], ['b', 0], ['c', 0]),
      ]);

      // Assert
      assert.deepEqual(
        fused.map(({ score }) => score),
        expected,
      );
    }),
);

void test.each(
  [[Number.NaN], [Number.POSITIVE_INFINITY], [0], [-1], [1.5]] as const,
  ([k]) =>
    test(`reciprocalRank refuses a k of ${k} when it is made, as Elasticsearch's rank_constant is an integer of 1 or more (#5720)`, () => {
      assert.throws(() => reciprocalRank({ k }), {
        name: 'RangeError',
        message: `The k of reciprocal rank fusion is an integer of 1 or more, not ${k}`,
      });
    }),
);

void test.each(
  [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  (score) =>
    test(`ScoreFusion refuses a doc whose score is ${score} with a TypeError that names the doc and its input, before a normalizer turns its whole list into NaN (#5700)`, () => {
      // Arrange
      const fusion = new ScoreFusion({
        normalizer: minMax(),
        combination: sum(),
      });
      const inputs = [
        input('keywords', 1, ['a', 0.9], ['b', 0.1]),
        input('meaning', 1, ['b1', 3], ['b2', score]),
      ];

      // Act and Assert
      assert.throws(() => fusion.fuse(inputs), {
        name: 'TypeError',
        message: `ScoreFusion reads scores, and b2 of meaning has the score ${score}: a score is a finite number`,
      });
    }),
);

test('ScoreFusion checks the scores of every input before it normalizes any, so a bad score of a later input is not hidden by a normalizer error of an earlier one (#5700)', () => {
  // Arrange: this normalizer gives NaN for every doc, so it would refuse a
  // of keywords first if the scores of meaning were checked later.
  const broken: ScoreNormalizer = { normalize: () => Number.NaN };
  const fusion = new ScoreFusion({ normalizer: broken, combination: sum() });
  const inputs = [
    input('keywords', 1, ['a', 0.9]),
    input('meaning', 1, ['b', Number.NaN]),
  ];

  // Act and Assert
  assert.throws(() => fusion.fuse(inputs), {
    name: 'TypeError',
    message:
      'ScoreFusion reads scores, and b of meaning has the score NaN: a score is a finite number',
  });
});

test('ScoreFusion checks the weights before the scores, so a bad weight beside a bad score is the RangeError of the weight', () => {
  // Arrange
  const fusion = new ScoreFusion({ normalizer: none(), combination: sum() });

  // Act and Assert
  assert.throws(() => fusion.fuse([input('keywords', -1, ['a', Number.NaN])]), {
    name: 'RangeError',
    message: 'The weight of keywords is a finite number of 0 or more, not -1',
  });
});

test("ScoreFusion checks the package's own normalizer too: minMax over finite scores whose range overflows is a TypeError, not a NaN in the list", () => {
  // Arrange
  const fusion = new ScoreFusion({ normalizer: minMax(), combination: sum() });
  const inputs = [
    input('keywords', 1, ['a', Number.MAX_VALUE], ['b', -Number.MAX_VALUE]),
  ];

  // Act and Assert
  assert.throws(() => fusion.fuse(inputs), {
    name: 'TypeError',
    message:
      'The normalizer gave a of keywords the score NaN: a normalized score is a finite number',
  });
});

test('ScoreFusion(minMax, sum) scales each list from its worst score (0) to its best (1), adds the weighted scaled scores of a doc, and gives 1 to each doc of a list whose scores are equal', () => {
  // Arrange
  const fusion = new ScoreFusion({ normalizer: minMax(), combination: sum() });
  const inputs = [
    input('keywords', 1, ['a', 4], ['b', 2], ['c', 0]),
    input('meaning', 2, ['c', 10], ['d', 6]),
    input('single', 1, ['e', 3]),
  ];

  // Act
  const fused = fusion.fuse(inputs);

  // Assert: Weaviate's FusionRelativeScore (hybrid_fusion.go) scales with
  // (score - min) / (max - min), multiplies by the weight and adds; a list
  // with max = min gives the weight itself.
  //   c = 1 * (0 - 0) / (4 - 0) + 2 * (10 - 6) / (10 - 6) = 0 + 2 = 2
  //   a = 1 * (4 - 0) / (4 - 0)                            = 1
  //   e = 1 * 1 (max = min)                                = 1, after a: a came first
  //   b = 1 * (2 - 0) / (4 - 0)                            = 0.5
  //   d = 2 * (6 - 6) / (10 - 6)                           = 0
  assert.deepEqual(scores(fused), [
    ['c', 2],
    ['a', 1],
    ['e', 1],
    ['b', 0.5],
    ['d', 0],
  ]);
});

test('ScoreFusion(distributionBased, sum) scales each list from mean - 3σ (0) to mean + 3σ (1) with the population σ, adds the weighted scaled scores, and gives 0.5 to each doc of a list with σ 0', () => {
  // Arrange
  const fusion = new ScoreFusion({
    normalizer: distributionBased(),
    combination: sum(),
  });
  const inputs = [
    input(
      'meaning',
      1,
      ['a', 9],
      ['b', 7],
      ['c', 5],
      ['d', 5],
      ['e', 4],
      ['f', 4],
      ['g', 4],
      ['h', 2],
    ),
    input('keywords', 2, ['a', 3], ['i', 3]),
    input('single', 1, ['j', 7]),
  ];

  // Act
  const fused = fusion.fuse(inputs);

  // Assert: LlamaIndex's _relative_score_fusion(dist_based=True) and
  // Haystack's _distribution_based_rank_fusion take the population σ:
  //   mean = 40 / 8 = 5, σ = sqrt((16 + 4 + 0 + 0 + 1 + 1 + 1 + 9) / 8) = sqrt(4) = 2
  //   min = 5 - 3 * 2 = -1, max = 5 + 3 * 2 = 11, score' = (score + 1) / 12
  // (Qdrant's sample σ, sqrt(32 / 7) = 2.138, would give other numbers.)
  // The keywords list and the single list have σ 0: 0.5 each, as Qdrant's
  // distr_norm gives it.
  //   a = (9 + 1) / 12 + 2 * 0.5 = 0.833333 + 1 = 1.833333
  //   i = 2 * 0.5 = 1
  //   b = (7 + 1) / 12 = 0.666667
  //   j = 0.5, c = d = (5 + 1) / 12 = 0.5: j came after c and d
  //   e = f = g = (4 + 1) / 12 = 0.416667, h = (2 + 1) / 12 = 0.25
  assert.deepEqual(scores(fused), [
    ['a', 10 / 12 + 1],
    ['i', 1],
    ['b', 8 / 12],
    ['c', 6 / 12],
    ['d', 6 / 12],
    ['j', 0.5],
    ['e', 5 / 12],
    ['f', 5 / 12],
    ['g', 5 / 12],
    ['h', 3 / 12],
  ]);
});

// The rest of the beyond case: rest-0 is also in the keywords list.
const rest = (first: number, others: number) =>
  Array.from({ length: 16 }, (_, index) => [
    `rest-${index}`,
    index === 0 ? first : others,
  ]);

// The scores and orders that relativeScoreFusion() and
// distributionBasedScoreFusion() gave on these lists before #5400 replaced
// them, as JavaScript prints each double, so each is exact.
void test.each(
  [
    {
      lists: 'shared ids under unequal weights, and a list of one doc',
      inputs: [
        input('keywords', 1, ['a', 4], ['b', 2], ['c', 0]),
        input('meaning', 2, ['c', 10], ['d', 6]),
        input('single', 1, ['e', 3]),
      ],
      byMinMax: [
        ['c', 2],
        ['a', 1],
        ['e', 1],
        ['b', 0.5],
        ['d', 0],
      ],
      byDistribution: [
        ['c', 1.6292091881014017],
        ['a', 0.7041241452319316],
        ['d', 0.6666666666666666],
        ['b', 0.5],
        ['e', 0.5],
      ],
    },
    {
      lists: 'a list with σ 0 and equal scores',
      inputs: [
        input(
          'meaning',
          1,
          ...[9, 7, 5, 5, 4, 4, 4, 2].map(
            (score, index) => [`m${index}`, score] as const,
          ),
        ),
        input('keywords', 2, ['m0', 3], ['k', 3]),
        input('single', 1, ['s', 7]),
      ],
      byMinMax: [
        ['m0', 3],
        ['k', 2],
        ['s', 1],
        ['m1', 0.7142857142857143],
        ['m2', 0.42857142857142855],
        ['m3', 0.42857142857142855],
        ['m4', 0.2857142857142857],
        ['m5', 0.2857142857142857],
        ['m6', 0.2857142857142857],
        ['m7', 0],
      ],
      byDistribution: [
        ['m0', 1.8333333333333335],
        ['k', 1],
        ['m1', 0.6666666666666666],
        ['m2', 0.5],
        ['m3', 0.5],
        ['s', 0.5],
        ['m4', 0.4166666666666667],
        ['m5', 0.4166666666666667],
        ['m6', 0.4166666666666667],
        ['m7', 0.25],
      ],
    },
    {
      lists:
        'scores not in order, of no exact binary value, and a list of weight 0',
      inputs: [
        input(
          'keywords',
          0.7,
          ['p', 0.83],
          ['q', 0.12],
          ['r', 0.91],
          ['s', 0.33],
          ['t', 0.57],
        ),
        input('meaning', 0.3, ['r', 12.5], ['u', 3.1], ['p', 7.7], ['v', 3.1]),
        input('zero', 0, ['q', 1], ['w', 2]),
      ],
      byMinMax: [
        ['r', 1],
        ['p', 0.7759224346889306],
        ['t', 0.3987341772151898],
        ['s', 0.18607594936708863],
        ['q', 0],
        ['u', 0],
        ['v', 0],
        ['w', 0],
      ],
      byDistribution: [
        ['r', 0.7163681189310014],
        ['p', 0.6232644126948067],
        ['t', 0.3570656224914591],
        ['s', 0.26285732260533745],
        ['q', 0.18042506020498097],
        ['u', 0.10500973153620717],
        ['v', 0.10500973153620717],
        ['w', 0],
      ],
    },
    {
      lists: 'ties across the lists',
      inputs: [
        input('keywords', 1, ['q', 9], ['p', 8]),
        input('meaning', 1, ['p', 9], ['q', 8]),
      ],
      byMinMax: [
        ['q', 1],
        ['p', 1],
      ],
      byDistribution: [
        ['q', 1],
        ['p', 1],
      ],
    },
    {
      lists: 'an id twice in one list, which adds from each place',
      inputs: [
        input('keywords', 1, ['a', 3], ['b', 2], ['a', 1]),
        input('meaning', 1, ['b', 5], ['c', 4]),
      ],
      byMinMax: [
        ['b', 1.5],
        ['a', 1],
        ['c', 0],
      ],
      byDistribution: [
        ['b', 1.1666666666666665],
        ['a', 1],
        ['c', 0.3333333333333333],
      ],
    },
    {
      lists: 'a score beyond mean + 3σ: mean 0, σ 1',
      inputs: [
        input(
          'meaning',
          1,
          ['top', 4],
          ...Array.from(
            { length: 16 },
            (_, index) => [`rest-${index}`, -0.25] as const,
          ),
        ),
        input('keywords', 0.5, ['top', 2], ['rest-0', 1]),
      ],
      byMinMax: [['top', 1.5], ...rest(0, 0)],
      byDistribution: [['top', 1.5], ...rest(0.625, 0.4583333333333333)],
    },
  ].flatMap(({ lists, inputs, byMinMax, byDistribution }) => [
    {
      lists,
      inputs,
      name: 'ScoreFusion(minMax, sum)',
      fusion: new ScoreFusion({ normalizer: minMax(), combination: sum() }),
      expected: byMinMax,
      was: 'relativeScoreFusion',
    },
    {
      lists,
      inputs,
      name: 'ScoreFusion(distributionBased, sum)',
      fusion: new ScoreFusion({
        normalizer: distributionBased(),
        combination: sum(),
      }),
      expected: byDistribution,
      was: 'distributionBasedScoreFusion',
    },
  ]),
  ({ lists, inputs, name, fusion, expected, was }) =>
    test(`${name} gives the scores, to the last bit, and the order that ${was} gave before #5400, on ${lists}`, () => {
      // Act
      const fused = fusion.fuse(inputs);

      // Assert
      assert.deepEqual(scores(fused), expected);
    }),
);

void test.each(
  [
    { statistic: 'min', first: 2, second: 3 },
    { statistic: 'max', first: 9, second: 4 },
    { statistic: 'mean', first: 5, second: 3.5 },
    // The population σ: the sample σ of the first list is sqrt(32 / 7).
    { statistic: 'std', first: 2, second: 0.5 },
    { statistic: 'l2', first: Math.sqrt(232), second: 5 },
  ] satisfies readonly {
    readonly statistic: keyof ListScores;
    readonly first: number;
    readonly second: number;
  }[],
  ({ statistic, first, second }) =>
    test(`a score normalizer reads the ${statistic} of its own list`, () => {
      // Arrange
      const reading: ScoreNormalizer = {
        normalize: (_score, list) => list[statistic],
      };
      const fusion = new ScoreFusion({
        normalizer: reading,
        combination: sum(),
      });
      const firstList = [5, 2, 9, 4, 4, 7, 4, 5];

      // Act
      const fused = fusion.fuse([
        input(
          'first',
          1,
          ...firstList.map((score, index) => [`f${index}`, score] as const),
        ),
        input('second', 1, ['s0', 3], ['s1', 4]),
      ]);

      // Assert
      assert.deepEqual(
        Object.fromEntries(fused.map(({ id, score }) => [id, score])),
        {
          ...Object.fromEntries(
            firstList.map((_, index) => [`f${index}`, first]),
          ),
          s0: second,
          s1: second,
        },
      );
    }),
);

void test.each(
  [
    {
      normalizer: 'minMax()',
      strategy: minMax(),
      rule: 'scales a list from its worst score (0) to its best (1)',
      docs: [
        ['a', 4],
        ['b', 2],
        ['c', 0],
      ] as const,
      expected: [1, 0.5, 0],
    },
    {
      normalizer: 'minMax()',
      strategy: minMax(),
      rule: 'scales negative scores too',
      docs: [
        ['a', -1],
        ['b', -2],
        ['c', -3],
      ] as const,
      expected: [1, 0.5, 0],
    },
    {
      normalizer: 'minMax()',
      strategy: minMax(),
      rule: 'gives 1 to each doc of a list whose scores are equal, as Elasticsearch, OpenSearch and Weaviate give it',
      docs: [
        ['a', 3],
        ['b', 3],
      ] as const,
      expected: [1, 1],
    },
    {
      normalizer: 'distributionBased()',
      strategy: distributionBased(),
      rule: 'scales a list from mean - 3σ (0) to mean + 3σ (1) with the population σ: mean 5, σ 2',
      docs: [
        ['a', 9],
        ['b', 7],
        ['c', 5],
        ['d', 5],
        ['e', 4],
        ['f', 4],
        ['g', 4],
        ['h', 2],
      ] as const,
      expected: [10, 8, 6, 6, 5, 5, 5, 3].map((score) => score / 12),
    },
    {
      normalizer: 'distributionBased()',
      strategy: distributionBased(),
      rule: 'gives 0.5 to each doc of a list with σ 0, as Qdrant gives it',
      docs: [
        ['a', 3],
        ['b', 3],
      ] as const,
      expected: [0.5, 0.5],
    },
    {
      normalizer: 'distributionBased()',
      strategy: distributionBased(),
      rule: 'does not clip a score beyond mean + 3σ to 1: mean 0, σ 1',
      docs: [
        ['top', 4] as const,
        ...Array.from(
          { length: 16 },
          (_, index) => [`rest-${index}`, -0.25] as const,
        ),
      ],
      expected: [7 / 6, ...Array.from({ length: 16 }, () => 11 / 24)],
    },
    {
      normalizer: 'none()',
      strategy: none(),
      rule: 'keeps each score as it is',
      docs: [
        ['a', 9],
        ['b', -2.5],
      ] as const,
      expected: [9, -2.5],
    },
  ],
  ({ normalizer, strategy, rule, docs, expected }) =>
    test(`${normalizer} ${rule}`, () => {
      // Arrange
      const fusion = new ScoreFusion({
        normalizer: strategy,
        combination: sum(),
      });

      // Act
      const fused = fusion.fuse([input('keywords', 1, ...docs)]);

      // Assert
      assert.deepEqual(
        fused,
        docs.map(([id], index) => ({ id, score: expected[index] })),
      );
    }),
);

void test.each(
  [
    {
      combination: 'sum()',
      strategy: sum(),
      rule: 'adds the weighted scores of an id: x = 2 * 0.25 + 1 * 0.5',
      expected: [
        { id: 'y', score: 3 },
        { id: 'x', score: 1 },
        { id: 'z', score: 0.75 },
      ],
    },
    {
      combination: 'max()',
      strategy: max(),
      rule: 'keeps the greatest weighted score of an id: x = max(2 * 0.25, 1 * 0.5)',
      expected: [
        { id: 'y', score: 3 },
        { id: 'z', score: 0.75 },
        { id: 'x', score: 0.5 },
      ],
    },
    {
      combination: 'arithmeticMean()',
      strategy: arithmeticMean(),
      rule: 'gives the weighted mean over the inputs that hold the id: x = (2 * 0.25 + 1 * 0.5) / 3, y = 2 * 1.5 / 2',
      expected: [
        { id: 'y', score: 1.5 },
        { id: 'z', score: 0.75 },
        { id: 'x', score: 1 / 3 },
      ],
    },
  ],
  ({ combination, strategy, rule, expected }) =>
    test(`${combination} ${rule}`, () => {
      // Arrange
      const fusion = new ScoreFusion({
        normalizer: none(),
        combination: strategy,
      });

      // Act
      const fused = fusion.fuse([
        input('keywords', 2, ['x', 0.25], ['y', 1.5]),
        input('meaning', 1, ['x', 0.5], ['z', 0.75]),
      ]);

      // Assert
      assert.deepEqual(fused, expected);
    }),
);

test('sum() starts from 0, so a doc whose only weighted score is -0 gets 0, as MTEB adds to 0.0', () => {
  // Arrange
  const fusion = new ScoreFusion({ normalizer: none(), combination: sum() });

  // Act
  const [fused] = fusion.fuse([input('keywords', 1, ['a', -0])]);

  // Assert
  assert.ok(Object.is(fused?.score, 0));
});

test('max() keeps the max of a shared id, not the sum; a weight of 2 on 0.3 ranks above 0.5; and a weight of 0 gives 0, which ranks above a negative score (#5585)', () => {
  // Arrange
  const fusion = new ScoreFusion({ normalizer: none(), combination: max() });

  // Act
  const fused = fusion.fuse([
    input('labels', 2, ['x', 0.3]),
    input('pubmed', 1, ['y', 0.5], ['x', 0.4], ['negative', -0.5]),
    input('web', 0, ['z', 7]),
  ]);

  // Assert
  assert.deepEqual(fused, [
    { id: 'x', score: 0.6 },
    { id: 'y', score: 0.5 },
    { id: 'z', score: 0 },
    { id: 'negative', score: -0.5 },
  ]);
});

test('arithmeticMean() gives 0 to an id whose inputs all have the weight 0, as OpenSearch gives it', () => {
  // Arrange
  const fusion = new ScoreFusion({
    normalizer: none(),
    combination: arithmeticMean(),
  });

  // Act
  const fused = fusion.fuse([
    input('keywords', 1, ['x', 1], ['y', 2]),
    input('meaning', 3, ['x', 3]),
    input('web', 0, ['z', 5]),
  ]);

  // Assert: x = (1 * 1 + 3 * 3) / (1 + 3), y = 1 * 2 / 1.
  assert.deepEqual(fused, [
    { id: 'x', score: 2.5 },
    { id: 'y', score: 2 },
    { id: 'z', score: 0 },
  ]);
});
