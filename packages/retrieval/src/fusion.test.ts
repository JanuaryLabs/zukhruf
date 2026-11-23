import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type ScoredPassage,
  distributionBasedScoreFusion,
  reciprocalRankFusion,
  relativeScoreFusion,
} from './index.ts';

const passage = (id: string, text = `text of ${id}`) => ({
  id,
  text,
  source: `doc-${id}`,
  seq: 0,
  start: 0,
  end: text.length,
  metadata: {},
});

// A result list as a retriever gives it, best first.
const list = (
  ...entries: readonly (readonly [string, number])[]
): ScoredPassage[] =>
  entries.map(([id, score]) => ({ passage: passage(id), score }));

const scores = (results: readonly ScoredPassage[]) =>
  results.map(({ passage: { id }, score }) => [id, score]);

const fusions = [
  ['reciprocalRankFusion', reciprocalRankFusion()],
  ['relativeScoreFusion', relativeScoreFusion()],
  ['distributionBasedScoreFusion', distributionBasedScoreFusion()],
] as const;

for (const [name, fusion] of fusions) {
  test(`${name} refuses weights that are not one for each list`, () => {
    // Arrange
    const lists = [list(['a', 2]), list(['b', 1])];

    // Act and Assert
    assert.throws(() => fusion.fuse(lists, [1]), {
      name: 'RangeError',
      message:
        'A fusion takes one weight for each list: got 1 weights for 2 lists',
    });
    assert.throws(() => fusion.fuse(lists, [1, 1, 1]), RangeError);
  });
}

test('reciprocal rank fusion gives each passage the sum of weight / (60 + rank) over the lists that hold it, with ranks from 1', () => {
  // Arrange: the scores of the lists play no part, only their order.
  const keywords = list(['a', 900], ['b', 800], ['c', 700]);
  const meaning = list(['c', 0.2], ['d', 0.1]);

  // Act
  const fused = reciprocalRankFusion().fuse([keywords, meaning], [1, 2]);

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
  assert.deepEqual(fused[0]?.passage, passage('c'));
});

test('reciprocal rank fusion takes the k that the caller gives', () => {
  // Arrange
  const lists = [list(['a', 1], ['b', 1])];

  // Act
  const fused = reciprocalRankFusion({ k: 1 }).fuse(lists, [1]);

  // Assert: 1 / (1 + 1) and 1 / (1 + 2).
  assert.deepEqual(scores(fused), [
    ['a', 1 / 2],
    ['b', 1 / 3],
  ]);
});

for (const [name, fusion] of fusions) {
  test(`${name}: equal fused scores keep the order in which their ids first appear, a passage is the one of the first list that holds it, and its vector the first that a list gives`, () => {
    // Arrange: q and p swap ranks and scores, so each fusion gives them equal
    // sums; ids in the other order than their first appearance show that the
    // order is not by id. Both lists give q a vector; only the meaning list
    // gives p one.
    const keywords: ScoredPassage[] = [
      { passage: passage('q'), score: 9, vector: [5, 5] },
      { passage: passage('p', 'p as the keywords list has it'), score: 8 },
    ];
    const meaning: ScoredPassage[] = [
      {
        passage: passage('p', 'p as the meaning list has it'),
        score: 9,
        vector: [1, 0],
      },
      { passage: passage('q'), score: 8, vector: [0, 1] },
    ];

    // Act
    const fused = fusion.fuse([keywords, meaning], [1, 1]);

    // Assert
    assert.deepEqual(
      fused.map(({ passage, vector }) => ({ passage, vector })),
      [
        { passage: passage('q'), vector: [5, 5] },
        {
          passage: passage('p', 'p as the keywords list has it'),
          vector: [1, 0],
        },
      ],
    );
    assert.equal(fused[0]?.score, fused[1]?.score);
  });
}

test('relative score fusion scales each list from its worst score (0) to its best (1), adds the weighted scaled scores of a passage, and gives 1 to each passage of a list whose scores are equal', () => {
  // Arrange
  const keywords = list(['a', 4], ['b', 2], ['c', 0]);
  const meaning = list(['c', 10], ['d', 6]);
  const single = list(['e', 3]);

  // Act
  const fused = relativeScoreFusion().fuse(
    [keywords, meaning, single],
    [1, 2, 1],
  );

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

test('distribution-based score fusion scales each list from mean - 3σ (0) to mean + 3σ (1) with the population σ, adds the weighted scaled scores, and gives 0.5 to each passage of a list with σ 0', () => {
  // Arrange
  const meaning = list(
    ['a', 9],
    ['b', 7],
    ['c', 5],
    ['d', 5],
    ['e', 4],
    ['f', 4],
    ['g', 4],
    ['h', 2],
  );
  const keywords = list(['a', 3], ['i', 3]);
  const single = list(['j', 7]);

  // Act
  const fused = distributionBasedScoreFusion().fuse(
    [meaning, keywords, single],
    [1, 2, 1],
  );

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

test('distribution-based score fusion does not clip a score beyond mean + 3σ to 1', () => {
  // Arrange: one score of 4 and sixteen of -0.25: mean 0 and
  // σ = sqrt((16 + 16 * 0.0625) / 17) = sqrt(17 / 17) = 1.
  const outlier = list(
    ['top', 4],
    ...Array.from(
      { length: 16 },
      (_, index) => [`rest-${index}`, -0.25] as const,
    ),
  );

  // Act
  const fused = distributionBasedScoreFusion().fuse([outlier], [1]);

  // Assert: (4 + 3) / 6 = 1.166667 and (-0.25 + 3) / 6 = 0.458333. None of
  // Qdrant, LlamaIndex and Haystack clips.
  assert.deepEqual(fused[0], { passage: passage('top'), score: 7 / 6 });
  assert.deepEqual(
    new Set(fused.slice(1).map(({ score }) => score)),
    new Set([11 / 24]),
  );
});
