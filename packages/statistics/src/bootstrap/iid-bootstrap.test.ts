import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

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

void test.each([3, -1, 1.5, 0.5, Number.NaN], (index) =>
  test(`IidBootstrap refuses the random index ${index}, which is out of 0 to n - 1`, () => {
    const bootstrap = new IidBootstrap({
      nResamples: 1,
      randomIndex: () => index,
    });
    assert.throws(() => bootstrap.distribution(['a', 'b', 'c'], () => 0), {
      name: 'RangeError',
      message: /^A random index is from 0 to 2/,
    });
  }),
);

void test.each([0, 1], (nResamples) =>
  test(`IidBootstrap with ${nResamples} resamples refuses data with no items`, () => {
    const bootstrap = new IidBootstrap({ nResamples, randomIndex: () => 0 });
    assert.throws(() => bootstrap.distribution([], () => 0), {
      name: 'RangeError',
      message: /^A bootstrap needs at least one item/,
    });
  }),
);

test('IidBootstrap.interval gives its method the statistic of every resample, in order, and returns the ends of that method from all nResamples resamples', () => {
  const generator = scripted([0, 0, 1, 1, 0, 1, 1, 0]);
  const bootstrap = new IidBootstrap({
    nResamples: 4,
    randomIndex: generator.randomIndex,
  });
  const distributions: number[][] = [];

  const interval = bootstrap.interval(
    [3, 7],
    (resample) => resample[0]! * 10 + resample[1]!,
    {
      level: 1,
      of: (distribution) => {
        distributions.push([...distribution]);
        return new ConfidenceInterval(-1, 1);
      },
    },
  );

  assert.deepEqual(distributions, [[33, 77, 37, 73]]);
  assert.deepEqual(
    {
      low: interval.low,
      high: interval.high,
      resamples: interval.resamples,
      nResamples: interval.nResamples,
    },
    { low: -1, high: 1, resamples: 4, nResamples: 4 },
  );
});

test('a resample whose statistic has no value is left out of the distribution, as R boot.ci keeps only the finite statistics, and the interval says how many resamples it kept', () => {
  const generator = scripted([0, 0, 1, 1, 0, 1, 1, 0]);
  const bootstrap = new IidBootstrap({
    nResamples: 4,
    randomIndex: generator.randomIndex,
  });
  const distributions: number[][] = [];
  // The resamples are [3, 3], [7, 7], [3, 7] and [7, 3]; one with no 7 has no
  // value.
  const statistic = (resample: readonly number[]) =>
    resample.includes(7) ? resample[0]! * 10 + resample[1]! : undefined;

  const interval = bootstrap.interval([3, 7], statistic, {
    level: 1,
    of: (distribution) => {
      distributions.push([...distribution]);
      return new ConfidenceInterval(-1, 1);
    },
  });

  assert.deepEqual(distributions, [[77, 37, 73]]);
  assert.deepEqual(
    { resamples: interval?.resamples, nResamples: interval?.nResamples },
    { resamples: 3, nResamples: 4 },
  );
});

test('when no resample has a value, the distribution is empty and the interval has no value, and the method is not called', () => {
  const bootstrap = new IidBootstrap({ nResamples: 3, randomIndex: () => 0 });
  const calls: number[][] = [];

  const interval = bootstrap.interval(['a', 'b'], () => undefined, {
    level: 1,
    of: (distribution) => {
      calls.push([...distribution]);
      return new ConfidenceInterval(0, 0);
    },
  });

  assert.equal(interval, undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(
    bootstrap.distribution(['a', 'b'], () => undefined),
    [],
  );
});
