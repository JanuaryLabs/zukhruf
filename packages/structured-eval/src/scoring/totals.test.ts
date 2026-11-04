import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Ratio,
  RatioOfSums,
  RecordCase,
  RecordScorer,
  RecordSpec,
  Totals,
} from '../index.ts';

test('Totals adds the scorecards of a run into micro averages: all right values over all expected values, not the mean of each record', () => {
  const scorer = new RecordScorer(new RecordSpec());
  const totals = new Totals();

  for (const [stated, expected] of [
    [{ a: 1 }, { a: 1 }],
    [{ a: 1 }, { a: 1, b: 2, c: 3 }],
  ] as const)
    totals.add(scorer.score(stated, new RecordCase(expected)), 1);

  assert.equal(totals.get('recall').value, 2 / 4);
});

test('Totals names a ratio that no scorecard gave', () => {
  const totals = new Totals();

  assert.throws(
    () => totals.get('recal'),
    /No scorecard gave a ratio named "recal"/,
  );
});

test('a ratio of sums adds as the sum() of CPython does, so ten tenths make one', () => {
  const sum = new RatioOfSums();

  for (let index = 0; index < 10; index++) sum.add(new Ratio(0.1, 1));

  assert.equal(sum.value, 0.1);
  assert.deepEqual(sum.ratio, new Ratio(1, 10));
});

test('a ratio of sums keeps a small part that a large one hides, as CPython gives sum([1.0, 1e100, 1.0, -1e100]) == 2.0', () => {
  const sum = new RatioOfSums();

  for (const part of [1, 1e100, 1, -1e100]) sum.add(new Ratio(part, 1));

  assert.deepEqual(sum.ratio, new Ratio(2, 4));
});

test('a ratio with no whole has the value 0', () => {
  assert.equal(new Ratio(3, 0).value, 0);
});
