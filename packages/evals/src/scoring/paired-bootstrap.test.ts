import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linear, PercentileInterval } from '@zukhruf/statistics';

import {
  PairedBootstrap,
  Precision,
  Recall,
  Run,
  ScorerSet,
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
