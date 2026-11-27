import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfidenceInterval,
  Linear,
  PercentileInterval,
} from '@zukhruf/statistics';

import { Bootstrap, Ratio, Run } from '../index.ts';

test('a resample draws the tests of a run, not their epochs', () => {
  const run = new Run();
  run.add('a', { ratios: new Map([['recall', new Ratio(1, 1)]]) }, 1);
  run.add('a', { ratios: new Map([['recall', new Ratio(0, 1)]]) }, 1);
  run.add('a', { ratios: new Map([['recall', new Ratio(0, 1)]]) }, 1);
  run.add('b', { ratios: new Map([['recall', new Ratio(0, 1)]]) }, 1);
  const bootstrap = new Bootstrap({
    nResamples: 1,
    // Each draw takes the first unit.
    randomIndex: () => 0,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(run, 'recall');

  // The first unit is test a, the mean of its three epochs, drawn twice: 1/3.
  // Its first epoch, drawn four times as a unit of its own, would give 1.
  assert.deepEqual(
    { low: interval.low, high: interval.high },
    { low: 1 / 3, high: 1 / 3 },
  );
});

test('the epochs of a test reduce to the mean of their parts and their wholes', () => {
  const run = new Run();
  run.add('a', { ratios: new Map([['recall', new Ratio(1, 1)]]) }, 1);
  run.add('a', { ratios: new Map([['recall', new Ratio(0, 3)]]) }, 1);
  run.add('b', { ratios: new Map([['recall', new Ratio(1, 1)]]) }, 1);
  const draws = [0, 1];
  const bootstrap = new Bootstrap({
    nResamples: 1,
    randomIndex: () => draws.shift() ?? Number.NaN,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(run, 'recall');

  // a is Ratio(0.5, 2) and b is Ratio(1, 1), so a and b give 1.5 / 3 = 0.5.
  // Pooling the epochs of a would give 2 / 5 = 0.4, and the mean of the
  // values of its epochs (0.5 over 1) would give 1.5 / 2 = 0.75.
  assert.deepEqual(
    { low: interval.low, high: interval.high },
    { low: 0.5, high: 0.5 },
  );
});

test('the statistic is the ratio of sums of the scored ratios, over as many draws as the run has tests', () => {
  const run = new Run();
  // A page with 65 expected values and 60 of them stated, and a page with one
  // expected value that the answer missed.
  run.add('a', { ratios: new Map([['recall', new Ratio(60, 65)]]) }, 1);
  run.add('b', { ratios: new Map([['recall', new Ratio(0, 1)]]) }, 1);
  const draws = [0, 1, 0, 0];
  const bootstrap = new Bootstrap({
    nResamples: 2,
    randomIndex: () => draws.shift() ?? Number.NaN,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(run, 'recall');

  // The resamples are [a, b], 60 / 66, and [a, a], 120 / 130. The mean of the
  // values would give 0.46 and 0.92; one draw for each resample, 0.92 and 0.92.
  assert.deepEqual(
    { low: interval.low, high: interval.high },
    { low: 60 / 66, high: 120 / 130 },
  );
});

test('the weight of the case of a test multiplies its ratio', () => {
  const run = new Run();
  run.add('a', { ratios: new Map([['recall', new Ratio(1, 1)]]) }, 3);
  run.add('b', { ratios: new Map([['recall', new Ratio(0, 1)]]) }, 1);
  const draws = [0, 1];
  const bootstrap = new Bootstrap({
    nResamples: 1,
    randomIndex: () => draws.shift() ?? Number.NaN,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(run, 'recall');

  // a counts 3 times and b once: 3 / 4. Without the weights, 1 / 2.
  assert.deepEqual(
    { low: interval.low, high: interval.high },
    { low: 0.75, high: 0.75 },
  );
});

test('a name that no test of the run gives throws, and names the name', () => {
  const run = new Run();
  run.add('a', { ratios: new Map([['recall', new Ratio(1, 1)]]) }, 1);
  const bootstrap = new Bootstrap({
    nResamples: 1,
    randomIndex: () => 0,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  assert.throws(() => bootstrap.interval(run, 'precision'), {
    name: 'Error',
    message: 'No scorecard of the run gave a ratio named "precision"',
  });
});

test('a test that does not give the name counts as Ratio(0, 0)', () => {
  const run = new Run();
  // The first test of the run does not give the name; a later one does.
  run.add('b', { ratios: new Map([['precision', new Ratio(1, 1)]]) }, 1);
  run.add('a', { ratios: new Map([['recall', new Ratio(1, 2)]]) }, 1);
  const draws = [0, 1];
  const bootstrap = new Bootstrap({
    nResamples: 1,
    randomIndex: () => draws.shift() ?? Number.NaN,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(run, 'recall');

  // b adds nothing to the recall of a and b: 1 / 2. As Ratio(0, 1), 1 / 3.
  assert.deepEqual(
    { low: interval.low, high: interval.high },
    { low: 0.5, high: 0.5 },
  );
});

test('a run with no tests throws a RangeError', () => {
  const bootstrap = new Bootstrap({
    nResamples: 1,
    randomIndex: () => 0,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  assert.throws(() => bootstrap.interval(new Run(), 'recall'), {
    name: 'RangeError',
    message: 'A bootstrap needs at least one item',
  });
});

test('the interval method of the caller reads the statistics in the order of the resamples', () => {
  const run = new Run();
  run.add('a', { ratios: new Map([['recall', new Ratio(60, 65)]]) }, 1);
  run.add('b', { ratios: new Map([['recall', new Ratio(0, 1)]]) }, 1);
  const draws = [0, 0, 0, 1];
  const bootstrap = new Bootstrap({
    nResamples: 2,
    randomIndex: () => draws.shift() ?? Number.NaN,
    // An interval of the first and the second statistic, in that order.
    interval: {
      level: 1,
      of: ([first = Number.NaN, second = Number.NaN]) =>
        new ConfidenceInterval(first, second),
    },
  });

  const interval = bootstrap.interval(run, 'recall');

  // The resamples are [a, a], 120 / 130, then [a, b], 60 / 66. A minimum and
  // a maximum of its own would give them the other way round.
  assert.deepEqual(
    { low: interval.low, high: interval.high },
    { low: 120 / 130, high: 60 / 66 },
  );
});

test('the level of a bootstrap is the level of its interval method', () => {
  const bootstrap = new Bootstrap({
    nResamples: 1,
    randomIndex: () => 0,
    interval: {
      level: 0.8,
      of: () => new ConfidenceInterval(0, 1),
    },
  });

  assert.equal(bootstrap.level, 0.8);
});
