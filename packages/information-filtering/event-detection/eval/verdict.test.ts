import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Interval } from './bootstrap.ts';
import { verdict } from './verdict.ts';

function interval(low: number, high: number): Interval {
  return {
    observed: (low + high) / 2,
    low,
    high,
    blocks: 100,
    replicates: 2000,
    seed: 3182,
  };
}

function result(options: {
  exam: Interval;
  mainScore?: number;
  baselines?: number[];
  regression?: Interval[];
}): string {
  return verdict({
    exam: options.exam,
    mainScore: options.mainScore ?? 0.8,
    baselines: options.baselines ?? [0.5, 0.1],
    regressionSets: Object.fromEntries(
      (options.regression ?? [interval(-0.01, 0.01)]).map((value, index) => [
        `set-${index}`,
        value,
      ]),
    ),
  }).result;
}

test('the candidate passes when the exam interval is entirely above 0, it beats both baselines and no regression set is worse', () => {
  assert.equal(result({ exam: interval(0.01, 0.05) }), 'pass');
  // A regression interval that ends at exactly 0 is not entirely below 0.
  assert.equal(
    result({ exam: interval(0.01, 0.05), regression: [interval(-0.03, 0)] }),
    'pass',
  );
});

test('an exam interval that includes 0 is inconclusive, and one entirely below 0 fails', () => {
  assert.equal(result({ exam: interval(-0.02, 0.05) }), 'inconclusive');
  assert.equal(result({ exam: interval(0, 0.05) }), 'inconclusive');
  assert.equal(result({ exam: interval(-0.05, 0) }), 'inconclusive');
  assert.equal(result({ exam: interval(-0.05, -0.01) }), 'fail');
});

test('a gain on the exam fails when the candidate does not beat either baseline, or any regression set is worse', () => {
  const gain = interval(0.01, 0.05);

  assert.equal(result({ exam: gain, mainScore: 0.5 }), 'fail');
  assert.equal(
    result({ exam: gain, mainScore: 0.5, baselines: [0.1, 0.5] }),
    'fail',
  );
  assert.equal(
    result({
      exam: gain,
      regression: [interval(-0.01, 0.01), interval(-0.03, -0.001)],
    }),
    'fail',
  );
});
