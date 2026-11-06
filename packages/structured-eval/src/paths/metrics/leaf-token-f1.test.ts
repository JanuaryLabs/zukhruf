import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JsonCase, LeafTokenF1, MetricScorer } from '../../index.ts';

const schema = { type: 'object' };

const sob = () =>
  new LeafTokenF1({ whenNoneExpected: 1, whenNoWords: 1, absentAs: null });

test('LeafTokenF1 gives the token F1 of a leaf with the arithmetic of token_f1: 2·p·r/(p + r) gives 0.33333333333333337 where 2·overlap/(stated + expected) gives 1/3', () => {
  const scorer = new MetricScorer({ f1: sob() });

  const scorecard = scorer.score(
    { a: 'x b c d e' },
    JsonCase.from({ expected: { a: 'X' }, schema }),
  );

  assert.equal(scorecard.ratios.get('f1')?.value, 0.33333333333333337);
});

test("LeafTokenF1 splits words as Python's \\w does: a letter outside ASCII is part of a word, so café is not caf and éthe holds no article", () => {
  const scorer = new MetricScorer({ f1: sob() });

  const scorecard = scorer.score(
    { a: 'caf', b: 'é', c: 'x' },
    JsonCase.from({ expected: { a: 'café', b: 'éthe', c: 'x' }, schema }),
  );

  assert.equal(scorecard.ratios.get('f1')?.value, 1 / 3);
});

test('LeafTokenF1 gives the whenNoneExpected of its caller for an expected value that has no leaf', () => {
  const scorer = new MetricScorer({
    quarter: new LeafTokenF1({
      whenNoneExpected: 0.25,
      whenNoWords: 1,
      absentAs: null,
    }),
    half: new LeafTokenF1({
      whenNoneExpected: 0.5,
      whenNoWords: 1,
      absentAs: null,
    }),
  });

  const scorecard = scorer.score(
    { a: 'x' },
    JsonCase.from({ expected: { offers: [] }, schema }),
  );

  assert.deepEqual(
    [
      scorecard.ratios.get('quarter')?.value,
      scorecard.ratios.get('half')?.value,
    ],
    [0.25, 0.5],
  );
});

test('LeafTokenF1 gives the whenNoWords of its caller for a leaf where neither value has a word', () => {
  const scorer = new MetricScorer({
    quarter: new LeafTokenF1({
      whenNoneExpected: 1,
      whenNoWords: 0.25,
      absentAs: null,
    }),
    half: new LeafTokenF1({
      whenNoneExpected: 1,
      whenNoWords: 0.5,
      absentAs: null,
    }),
  });

  const scorecard = scorer.score(
    { a: '!', b: 'y' },
    JsonCase.from({ expected: { a: 'The', b: 'y' }, schema }),
  );

  assert.deepEqual(
    [
      scorecard.ratios.get('quarter')?.value,
      scorecard.ratios.get('half')?.value,
    ],
    [(0.25 + 1) / 2, (0.5 + 1) / 2],
  );
});

test('LeafTokenF1 reads a path that the stated value does not have as the absentAs of its caller, and a stated null as null', () => {
  const scorer = new MetricScorer({
    none: new LeafTokenF1({
      whenNoneExpected: 1,
      whenNoWords: 1,
      absentAs: null,
    }),
    word: new LeafTokenF1({
      whenNoneExpected: 1,
      whenNoWords: 1,
      absentAs: 'x',
    }),
  });

  const scorecards = [
    scorer.score(
      { b: 'z' },
      JsonCase.from({ expected: { a: 'x y', b: 'z' }, schema }),
    ),
    scorer.score({ a: null }, JsonCase.from({ expected: { a: null }, schema })),
  ];

  assert.deepEqual(
    scorecards.map((scorecard) => [
      scorecard.ratios.get('none')?.value,
      scorecard.ratios.get('word')?.value,
    ]),
    [
      [0.5, (2 / 3 + 1) / 2],
      [1, 1],
    ],
  );
});
