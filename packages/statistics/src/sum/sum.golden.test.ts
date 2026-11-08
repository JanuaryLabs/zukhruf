import assert from 'node:assert/strict';
import { test } from 'node:test';

import fixture from '../fixtures/sum/expected.json' with { type: 'json' };
import { mean, nanmean, sum } from '../index.ts';

// fixtures/sum/expected.json holds numpy.sum and numpy.mean of NumPy 2.5.4
// for each array, and numpy.nanmean for each array of nanArrays (NaN is null in
// the JSON); sum/generate.py makes it. The lengths reach each branch of
// numpy's pairwise sum, a sum from left to right gives other bits for most of
// the random arrays, and the arrays of -0.0 sum to 0.0.
test('sum gives the value of numpy.sum for each array, to the last bit', () => {
  const sums = fixture.arrays.map((values) => sum(values));

  assert.deepEqual(sums, fixture.sum);
});

test('mean gives the value of numpy.mean for each array, to the last bit', () => {
  const means = fixture.arrays.map((values) => mean(values));

  assert.deepEqual(means, fixture.mean);
});

test('sum of no values is 0 and mean of no values is NaN, as NumPy gives them', () => {
  assert.equal(sum([]), 0);
  assert.equal(mean([]), Number.NaN);
});

test('nanmean gives the value of numpy.nanmean for each array, NaN values included, to the last bit', () => {
  const nanmeans = fixture.nanArrays.map((values) =>
    nanmean(values.map((value) => value ?? Number.NaN)),
  );

  assert.deepEqual(
    nanmeans,
    fixture.nanmean.map((value) => value ?? Number.NaN),
  );
});
