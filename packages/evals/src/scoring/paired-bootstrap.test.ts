import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import {
  PairedBootstrap,
  Precision,
  Ratio,
  Recall,
  Run,
  ScorerSet,
  type Verdict,
  decide,
} from '../index.ts';
import { ConfigCase, TreeWalk, ValueMatches } from '../structured/index.ts';

const scorer = new ScorerSet(
  { recall: new Recall(new ValueMatches()) },
  { comparer: new TreeWalk() },
);
const scorecard = scorer.score(
  { a: 1 },
  new ConfigCase().from({ expected: { a: 1 } }),
);
const paired = new PairedBootstrap({
  nResamples: 10,
  randomIndex: () => 0,
  interval: new PercentileInterval({
    low: 0.025,
    high: 0.975,
    method: new Linear(),
  }),
});

test('a run refuses a second epoch of a test with another weight, because the weight belongs to the case', () => {
  const run = new Run();
  run.add('t1', scorecard, 2);

  assert.throws(() => run.add('t1', scorecard, 1), {
    name: 'RangeError',
    message:
      'Test "t1" has the weight 2, not 1: the weight belongs to the case',
  });
});

test('a run takes the ratios of a scorecard alone, so a host that scores without a scorer of this package adds its own numbers', () => {
  const recall = (value: number) => ({
    ratios: new Map([['recall', new Ratio(value, 1)]]),
  });
  const baseline = new Run();
  const change = new Run();
  for (const id of ['t1', 't2']) {
    baseline.add(id, recall(0), 1);
    change.add(id, recall(1), 1);
  }

  const verdict = paired.verdict(baseline, change, 'recall', {
    higherIsBetter: true,
  });

  assert.ok(verdict.result !== 'untested');
  assert.equal(verdict.difference.observed, 1);
  assert.equal(verdict.improvements, 2);
});

test('a paired bootstrap refuses two runs that do not have the same tests, and names each test id of one run only', () => {
  const baseline = new Run();
  const change = new Run();
  for (const id of ['t1', 't2', 't3']) baseline.add(id, scorecard, 1);
  for (const id of ['t4', 't2']) change.add(id, scorecard, 1);

  assert.throws(
    () => paired.verdict(baseline, change, 'recall', { higherIsBetter: true }),
    {
      name: 'RangeError',
      message:
        'A paired bootstrap needs the same test ids in the baseline and the change. Not in both: t1, t3, t4',
    },
  );
});

test('a paired bootstrap refuses a test whose weight in the change is not its weight in the baseline', () => {
  const baseline = new Run();
  const change = new Run();
  baseline.add('t1', scorecard, 1);
  baseline.add('t2', scorecard, 1);
  change.add('t1', scorecard, 1);
  change.add('t2', scorecard, 3);

  assert.throws(
    () => paired.verdict(baseline, change, 'recall', { higherIsBetter: true }),
    {
      name: 'RangeError',
      message:
        'A test has the same weight in the baseline and the change. Other weights: t2 (1 and 3)',
    },
  );
});

test('a paired bootstrap names the run that gives no ratio of the name', () => {
  const precision = new ScorerSet(
    { precision: new Precision(new ValueMatches()) },
    { comparer: new TreeWalk() },
  ).score({ a: 1 }, new ConfigCase().from({ expected: { a: 1 } }));
  const recallRun = new Run();
  const precisionRun = new Run();
  recallRun.add('t1', scorecard, 1);
  precisionRun.add('t1', precision, 1);

  assert.throws(
    () =>
      paired.verdict(precisionRun, recallRun, 'recall', {
        higherIsBetter: true,
      }),
    {
      name: 'Error',
      message: 'No scorecard of the baseline run gave a ratio named "recall"',
    },
  );
  assert.throws(
    () =>
      paired.verdict(recallRun, precisionRun, 'recall', {
        higherIsBetter: true,
      }),
    {
      name: 'Error',
      message: 'No scorecard of the change run gave a ratio named "recall"',
    },
  );
});

test('the difference of a paired bootstrap weighs each test by the weight of its case', () => {
  const recall = (ratio: Ratio) => ({ ratios: new Map([['recall', ratio]]) });
  const baseline = new Run();
  const change = new Run();
  baseline.add('t1', recall(new Ratio(1, 2)), 3);
  change.add('t1', recall(new Ratio(2, 2)), 3);
  baseline.add('t2', recall(new Ratio(2, 2)), 1);
  change.add('t2', recall(new Ratio(0, 2)), 1);

  const verdict = paired.verdict(baseline, change, 'recall', {
    higherIsBetter: true,
  });

  // Weighted: the change is (6 + 0) / (6 + 2) = 0.75 and the baseline
  // (3 + 2) / (6 + 2) = 0.625; with no weights it would be 0.5 − 0.75.
  assert.ok(verdict.result !== 'untested');
  assert.equal(verdict.difference.observed, 0.125);
});

test('a resample where a run has no whole is left out of a paired bootstrap, and its p-value divides by the resamples that are left', () => {
  const recall = (part: number, whole: number) => ({
    ratios: new Map([['recall', new Ratio(part, whole)]]),
  });
  const baseline = new Run();
  const change = new Run();
  baseline.add('t1', recall(0, 0), 1);
  change.add('t1', recall(0, 0), 1);
  baseline.add('t2', recall(0, 1), 1);
  change.add('t2', recall(1, 1), 1);
  baseline.add('t3', recall(1, 1), 1);
  change.add('t3', recall(0, 1), 1);
  // [t1, t1, t1] has no whole; [t2, t2, t2] gives +1, [t3, t3, t3] −1 and
  // [t2, t2, t1] +1.
  const draws = [0, 0, 0, 1, 1, 1, 2, 2, 2, 1, 1, 0];
  const bootstrap = new PairedBootstrap({
    nResamples: 4,
    randomIndex: () => draws.shift() ?? Number.NaN,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const verdict = bootstrap.verdict(baseline, change, 'recall', {
    higherIsBetter: true,
  });

  // 1 of the 3 kept differences is at or below 0 and 2 at or above it, so p
  // is 2 · 1/3. Over all 4 resamples it would be 2 · 1/4.
  assert.ok(verdict.result !== 'untested');
  assert.deepEqual(
    {
      p: verdict.p,
      resamples: verdict.resamples,
      nResamples: verdict.nResamples,
      low: verdict.difference.low,
      high: verdict.difference.high,
    },
    { p: 2 / 3, resamples: 3, nResamples: 4, low: -1, high: 1 },
  );
});

test('a paired bootstrap where no resample gives both runs a whole gives an untested verdict, with no difference, interval or p', () => {
  const recall = (part: number, whole: number) => ({
    ratios: new Map([['recall', new Ratio(part, whole)]]),
  });
  const baseline = new Run();
  const change = new Run();
  baseline.add('t1', recall(0, 0), 1);
  change.add('t1', recall(0, 0), 1);
  baseline.add('t2', recall(1, 1), 1);
  change.add('t2', recall(0, 1), 1);
  const bootstrap = new PairedBootstrap({
    nResamples: 2,
    // Each resample is [t1, t1].
    randomIndex: () => 0,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const verdict = bootstrap.verdict(baseline, change, 'recall', {
    higherIsBetter: true,
  });

  assert.deepEqual(verdict, {
    name: 'recall',
    result: 'untested',
    improvements: 0,
    regressions: 1,
    ties: 1,
    tests: 2,
  });
});

test('an untested verdict cannot hold a difference, an interval or a p', () => {
  // typecheck proves this test: an @ts-expect-error that has no error fails it.
  const untested: Verdict = {
    name: 'recall',
    result: 'untested',
    improvements: 0,
    regressions: 0,
    ties: 0,
    tests: 0,
    // @ts-expect-error An untested verdict has no p.
    p: 0.5,
  };

  assert.equal(untested.result, 'untested');
});

// t1 falls by 1 and t2 and t3 rise by 0.01 (99 of 100 to 100 of 100), so the
// change is (0 + 100 + 100) / 201 against (1 + 99 + 99) / 201: +1/201. A
// resample of t1 alone is −1 and one of t2 alone +0.01. With 50 of 2000
// resamples at −1, p = 2 · 50 / 2000 = 0.05, and NumPy's linear 2.5%
// quantile sits at position 1999 · 0.025 = 49.975, between the 50th (−1) and
// the 51st (+0.01): −1 + 0.975 · 1.01, below 0, so the interval holds 0 while
// p counts. With 51 of 2000, p is 0.051.
void test.each(
  [
    { against: 50, higherIsBetter: true, result: 'better' },
    { against: 50, higherIsBetter: false, result: 'worse' },
    { against: 51, higherIsBetter: true, result: 'inconclusive' },
    { against: 51, higherIsBetter: false, result: 'inconclusive' },
  ] as const,
  ({ against, higherIsBetter, result }) =>
    test(`a paired bootstrap with ${against} of 2000 resamples against the change reads ${result} with higherIsBetter ${higherIsBetter}, by its p and not by its interval, which holds 0`, () => {
      const recall = (part: number, whole: number) => ({
        ratios: new Map([['recall', new Ratio(part, whole)]]),
      });
      const baseline = new Run();
      const change = new Run();
      baseline.add('t1', recall(1, 1), 1);
      change.add('t1', recall(0, 1), 1);
      baseline.add('t2', recall(99, 100), 1);
      change.add('t2', recall(100, 100), 1);
      baseline.add('t3', recall(99, 100), 1);
      change.add('t3', recall(100, 100), 1);
      const draws = Array.from({ length: 2000 }, (_, resample) =>
        Array.from({ length: 3 }, () => (resample < against ? 0 : 1)),
      ).flat();
      const bootstrap = new PairedBootstrap({
        nResamples: 2000,
        randomIndex: () => draws.shift() ?? Number.NaN,
        interval: new PercentileInterval({
          low: 0.025,
          high: 0.975,
          method: new Linear(),
        }),
      });

      const verdict = bootstrap.verdict(baseline, change, 'recall', {
        higherIsBetter,
      });

      assert.ok(verdict.result !== 'untested');
      const { observed, low, high } = verdict.difference;
      assert.deepEqual(
        {
          result: verdict.result,
          p: verdict.p,
          holdsZero: low < 0 && high > 0,
          decided: decide(verdict.p, observed, higherIsBetter),
        },
        { result, p: (2 * against) / 2000, holdsZero: true, decided: result },
      );
    }),
);
