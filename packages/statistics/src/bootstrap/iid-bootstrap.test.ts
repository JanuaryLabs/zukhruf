import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfidenceInterval, IidBootstrap } from '../index.ts';

// A generator that gives these indices in turn and records each n it gets.
const scripted = (indices: readonly number[]) => {
  const queue = [...indices];
  const calls: number[] = [];
  return {
    calls,
    randomIndex: (n: number) => {
      calls.push(n);
      const index = queue.shift();
      if (index === undefined) throw new Error('No index is left');
      return index;
    },
  };
};

test('IidBootstrap draws one random index from 0 to n - 1 for each item, resample by resample, and gives the statistic of each of the nResamples resamples in order', () => {
  const generator = scripted([2, 0, 0, 1, 1, 2]);
  const bootstrap = new IidBootstrap({
    nResamples: 2,
    randomIndex: generator.randomIndex,
  });
  const resamples: string[][] = [];

  const distribution = bootstrap.distribution(['a', 'b', 'c'], (resample) => {
    resamples.push([...resample]);
    return resamples.length * 10;
  });

  assert.deepEqual(generator.calls, [3, 3, 3, 3, 3, 3]);
  assert.deepEqual(resamples, [
    ['c', 'a', 'a'],
    ['b', 'b', 'c'],
  ]);
  assert.deepEqual(distribution, [10, 20]);
});

test('IidBootstrap refuses a random index out of 0 to n - 1, and data with no items', () => {
  for (const index of [3, -1, 1.5, 0.5, Number.NaN]) {
    const bootstrap = new IidBootstrap({
      nResamples: 1,
      randomIndex: () => index,
    });
    assert.throws(() => bootstrap.distribution(['a', 'b', 'c'], () => 0), {
      name: 'RangeError',
      message: /^A random index is from 0 to 2/,
    });
  }
  for (const nResamples of [0, 1]) {
    const bootstrap = new IidBootstrap({ nResamples, randomIndex: () => 0 });
    assert.throws(() => bootstrap.distribution([], () => 0), {
      name: 'RangeError',
      message: /^A bootstrap needs at least one item/,
    });
  }
});

test('IidBootstrap.interval gives its method the statistic of every resample, in order, and returns the interval of that method', () => {
  const generator = scripted([0, 0, 1, 1, 0, 1, 1, 0]);
  const bootstrap = new IidBootstrap({
    nResamples: 4,
    randomIndex: generator.randomIndex,
  });
  const distributions: number[][] = [];
  const marker = new ConfidenceInterval(-1, 1);

  const interval = bootstrap.interval(
    [3, 7],
    (resample) => resample[0]! * 10 + resample[1]!,
    {
      of: (distribution) => {
        distributions.push([...distribution]);
        return marker;
      },
    },
  );

  assert.deepEqual(distributions, [[33, 77, 37, 73]]);
  assert.equal(interval, marker);
});
