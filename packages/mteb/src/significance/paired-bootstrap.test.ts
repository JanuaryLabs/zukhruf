import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide, pairedBootstrapTest } from '../index.ts';

// 37 queries gain 1 and 3 lose 5.6556, so a replicate that draws 6 of the
// losses has a mean of 0.00166 and one that draws 7 has a mean of -0.16473.
// With seed 2, 50 of the 2000 means are at or below 0 (p = 0.05), and the
// lower bound of the interval, between the 50th and 51st means, is below 0;
// with seed 39, 51 are (p = 0.051).
test('a change whose p is exactly 0.05 is better, as a report decides it, though its interval still contains 0, and one whose p is 0.051 is inconclusive', () => {
  const ids = Array.from({ length: 40 }, (_, index) => `q${index + 10}`);
  const baseline = new Map(ids.map((id) => [id, 0]));
  const change = new Map(ids.map((id, index) => [id, index < 3 ? -5.6556 : 1]));

  const atAlpha = pairedBootstrapTest(baseline, change, { seed: 2 });
  const aboveAlpha = pairedBootstrapTest(baseline, change, { seed: 39 });

  assert.deepEqual(
    {
      atAlpha: {
        p: atAlpha.p,
        result: atAlpha.result,
        decided: decide(atAlpha.p, atAlpha.observed),
        intervalContainsZero: atAlpha.low <= 0 && atAlpha.high >= 0,
      },
      aboveAlpha: { p: aboveAlpha.p, result: aboveAlpha.result },
    },
    {
      atAlpha: {
        p: 0.05,
        result: 'better',
        decided: 'better',
        intervalContainsZero: true,
      },
      aboveAlpha: { p: 0.051, result: 'inconclusive' },
    },
  );
});
