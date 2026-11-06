import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  JsonCase,
  JsonTextCase,
  JsonTextScorer,
  LeafExactMatch,
  MetricScorer,
} from '../../index.ts';

test("LeafExactMatch compares leaves as Python's == does: True == 1 == 1.0, an int and a float only when they are the same number exactly, and '1' is not 1", () => {
  const scorer = new JsonTextScorer(
    new MetricScorer({
      match: new LeafExactMatch({ whenNoneExpected: 1 }),
    }),
  );
  const testCase = JsonTextCase.from({
    expected:
      '{"t": 1, "f": 1, "big": 9007199254740993, "s": 1, "n": null, "x": "a"}',
    schema: { type: 'object' },
  });

  const scorecard = scorer.score(
    '{"t": true, "f": 1.0, "big": 9007199254740992.0, "s": "1", "n": null, "x": "a"}',
    testCase,
  );

  assert.equal(scorecard.ratios.get('match')?.value, 4 / 6);
});

test('LeafExactMatch gives the whenNoneExpected of its caller for an expected value that has no leaf', () => {
  const scorer = new MetricScorer({
    quarter: new LeafExactMatch({ whenNoneExpected: 0.25 }),
    half: new LeafExactMatch({ whenNoneExpected: 0.5 }),
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
