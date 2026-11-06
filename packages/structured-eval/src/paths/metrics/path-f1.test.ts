import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JsonCase, MetricScorer, PathF1 } from '../../index.ts';

test('PathF1 gives the F1 of the leaf paths that both values have, whatever their values, with the arithmetic of f1_from_counts: 2·p·r/(p + r) gives 0.33333333333333337 where 2·shared/(stated + expected) gives 1/3', () => {
  const scorer = new MetricScorer({ f1: new PathF1({ whenNoPaths: 0 }) });
  const testCase = JsonCase.from({
    expected: { a: 1 },
    schema: { type: 'object' },
  });

  const scorecard = scorer.score(
    { a: 'other', b: 2, c: 3, d: 4, e: 5 },
    testCase,
  );

  assert.equal(scorecard.ratios.get('f1')?.value, 0.33333333333333337);
});

test('PathF1 gives the whenNoPaths of its caller when neither value has a path, and 0 when only one of them has paths', () => {
  const scorer = new MetricScorer({
    quarter: new PathF1({ whenNoPaths: 0.25 }),
    half: new PathF1({ whenNoPaths: 0.5 }),
  });
  const empty = JsonCase.from({ expected: {}, schema: { type: 'object' } });
  const full = JsonCase.from({
    expected: { a: 1 },
    schema: { type: 'object' },
  });

  const scorecards = [
    scorer.score({}, empty),
    scorer.score({ a: 1 }, empty),
    scorer.score({}, full),
  ];

  assert.deepEqual(
    scorecards.map((scorecard) => [
      scorecard.ratios.get('quarter')?.value,
      scorecard.ratios.get('half')?.value,
    ]),
    [
      [0.25, 0.5],
      [0, 0],
      [0, 0],
    ],
  );
});
