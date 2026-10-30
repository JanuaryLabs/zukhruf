import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fit } from './irls.ts';

const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-4,
    `expected ${expected}, got ${actual}`,
  );

// One binary feature: 2 of 10 rows with x = 0 are positive, and 24 of 30 rows
// with x = 1. The feature has the mean 0.75 and the standard deviation
// sqrt(0.75 * 0.25). The maximum-likelihood model gives logit(0.2) = -ln 4 at
// x = 0 and logit(0.8) = ln 4 at x = 1. A step of 1 in x is 1 / sd standard
// units, so the weight is 2 ln 4 * sd, and the intercept, at the mean, is
// ln 4 - 2 ln 4 * 0.25 = ln 2.
const SD = Math.sqrt(0.75 * 0.25);

function rows(extra: readonly number[]): {
  rows: number[][];
  labels: number[];
} {
  const data = [
    ...Array.from({ length: 10 }, (_, i) => ({ x: 0, y: i < 2 ? 1 : 0 })),
    ...Array.from({ length: 30 }, (_, i) => ({ x: 1, y: i < 24 ? 1 : 0 })),
  ];
  return {
    rows: data.map(({ x }) => [x, ...extra]),
    labels: data.map(({ y }) => y),
  };
}

test('the fit gives the maximum-likelihood weights of standardized features, with their mean and standard deviation', () => {
  const { rows: features, labels } = rows([]);

  const fitted = fit(features, labels);

  close(fitted.weights[0]!, Math.log(2));
  close(fitted.weights[1]!, 2 * Math.log(4) * SD);
  close(fitted.mean[0]!, 0.75);
  close(fitted.sd[0]!, SD);
  assert.deepEqual([fitted.rows, fitted.positives], [40, 26]);
});

test('a feature with one value for every row gets the weight 0, and the other weights stay', () => {
  const { rows: features, labels } = rows([3]);

  const fitted = fit(features, labels);

  close(fitted.weights[1]!, 2 * Math.log(4) * SD);
  close(fitted.weights[2]!, 0);
  assert.equal(fitted.sd[1], 1);
});
