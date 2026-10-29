import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scores } from './metrics.ts';

test('the scores of a run are those of the research metric_row', () => {
  const result = scores(
    [true, true, false, false],
    [0.9, 0.6, 0.2, 0.1],
    [true, false, true, false],
  );

  // tp 1, fp 1, fn 1; Brier (0.01 + 0.36 + 0.64 + 0.01) / 4; base rate 0.5.
  assert.equal(result.f05, 1.25 / 2.5);
  assert.ok(Math.abs(result.brier - 0.255) < 1e-15);
  assert.ok(Math.abs(result.brierSkill - (1 - 0.255 / 0.25)) < 1e-12);
  assert.deepEqual(
    [result.tp, result.fp, result.fn, result.accepted],
    [1, 1, 1, 2],
  );
});

test('a stream with no relevant article has no Brier skill', () => {
  assert.ok(Number.isNaN(scores([false], [0.1], [false]).brierSkill));
});
