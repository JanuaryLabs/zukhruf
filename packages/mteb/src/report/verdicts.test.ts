import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Holm } from '@zukhruf/statistics';

import { decide } from './index.ts';

// A bootstrap p is a share of resamples: 25 of 2000 against a change give
// p = 2 · 25 / 2000 = 0.025, which Holm doubles in a family of two to 0.05
// exactly, as the Verdicts of @zukhruf/evals decides it.
test('a difference whose Holm-adjusted p is exactly 0.05 counts, and one just above 0.05 does not', () => {
  const [atAlpha = Number.NaN] = new Holm().adjust([(2 * 25) / 2000, 1]);
  const [aboveAlpha = Number.NaN] = new Holm().adjust([(2 * 26) / 2000, 1]);

  const actual = {
    atAlpha,
    better: decide(atAlpha, 0.5),
    worse: decide(atAlpha, -0.5),
    above: decide(aboveAlpha, 0.5),
  };

  assert.deepEqual(actual, {
    atAlpha: 0.05,
    better: 'better',
    worse: 'worse',
    above: 'inconclusive',
  });
});
