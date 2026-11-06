import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JsonCase, MetricScorer, PathRecall } from '../../index.ts';

test('PathRecall gives the share of the expected leaf paths that the stated value has, whatever their values; a path that only the stated value has does not count', () => {
  const scorer = new MetricScorer({
    recall: new PathRecall({ whenNoneExpected: 0 }),
  });
  const testCase = JsonCase.from({
    expected: { a: 1, b: { c: 2 }, d: [3] },
    schema: { type: 'object' },
  });

  const scorecard = scorer.score(
    { a: 'other', b: { c: 2 }, d: 3, e: 4 },
    testCase,
  );

  assert.equal(scorecard.ratios.get('recall')?.value, 2 / 3);
});

test('PathRecall gives the whenNoneExpected of its caller for an expected value that has no leaf', () => {
  const scorer = new MetricScorer({
    quarter: new PathRecall({ whenNoneExpected: 0.25 }),
    half: new PathRecall({ whenNoneExpected: 0.5 }),
  });

  const scorecard = scorer.score(
    { a: 1 },
    JsonCase.from({ expected: { offers: [] }, schema: { type: 'object' } }),
  );

  assert.deepEqual(
    [
      scorecard.ratios.get('quarter')?.value,
      scorecard.ratios.get('half')?.value,
    ],
    [0.25, 0.5],
  );
});
