import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { ConfidenceInterval, Lower, PercentileInterval } from '../index.ts';

test('PercentileInterval reads its low and its high quantile with its quantile method from a sorted copy, and leaves the distribution as it is', () => {
  const distribution = [10, 9, 100, -1, 2];

  const interval = new PercentileInterval({
    low: 0.2,
    high: 0.8,
    method: new Lower(),
  }).of(distribution);

  // Sorted by value, [-1, 2, 9, 10, 100] (as text it would be [-1, 10, 100,
  // 2, 9]): the lower method reads the index floor(0.8) = 0 and floor(3.2) = 3.
  assert.deepEqual([interval.low, interval.high], [-1, 10]);
  assert.deepEqual(distribution, [10, 9, 100, -1, 2]);
});

void test.each(
  [
    { low: 0.025, high: 0.975, level: 0.95 },
    { low: 0.05, high: 0.95, level: 0.9 },
  ],
  ({ low, high, level }) =>
    test(`a PercentileInterval of the ${low} and the ${high} quantile has the level ${level}`, () => {
      const interval = new PercentileInterval({
        low,
        high,
        method: new Lower(),
      });

      assert.ok(Math.abs(interval.level - level) < 1e-12);
    }),
);

test('a confidence interval lies above a value only when its low end is above it, and below a value only when its high end is below it', () => {
  const sides = (low: number, high: number, value: number) => {
    const interval = new ConfidenceInterval(low, high);
    return [interval.isAbove(value), interval.isBelow(value)];
  };

  assert.deepEqual(sides(1, 2, 0), [true, false]);
  assert.deepEqual(sides(-2, -1, 0), [false, true]);
  assert.deepEqual(sides(0, 2, 0), [false, false]);
  assert.deepEqual(sides(-2, 0, 0), [false, false]);
  assert.deepEqual(sides(-1, 2, 0), [false, false]);
  assert.deepEqual(sides(1, 5, 3), [false, false]);
});
