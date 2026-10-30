import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareStrings, pythonRound, pythonRoundToInteger } from './python.ts';

// The expected values are those of CPython 3.12.

test('round to 5 and 2 digits rounds the exact binary value, a tie to even', () => {
  const cases: [number, number, number][] = [
    [0.015625, 0.01562, 0.02],
    [0.125, 0.125, 0.12],
    [2.675, 2.675, 2.67],
    [1.000005, 1.00001, 1],
    [0.000005, 0.00001, 0],
    [-0.015625, -0.01562, -0.02],
    [0.123455, 0.12345, 0.12],
    [0.999995, 0.99999, 1],
    [1e-7, 0, 0],
    [0.3333333333333333, 0.33333, 0.33],
    [5e-324, 0, 0],
    [123456.789015625, 123456.78902, 123456.79],
  ];

  const rounded = cases.map(([value]) => [
    pythonRound(value, 5),
    pythonRound(value, 2),
  ]);

  assert.deepEqual(
    rounded,
    cases.map(([, five, two]) => [five, two]),
  );
});

test('round to an integer rounds a tie to even', () => {
  const cases: [number, number][] = [
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [-0.5, 0],
    [-1.5, -2],
    [2.4999999999999996, 2],
    [1.5000000000000002, 2],
    [3.0000000000000004, 3],
  ];

  const rounded = cases.map(([value]) => pythonRoundToInteger(value) + 0);

  assert.deepEqual(
    rounded,
    cases.map(([, integer]) => integer),
  );
});

test('strings sort by code point, as in Python', () => {
  const sorted = ['b', 'a', 'é', '😀', '￿', 'A'].sort(compareStrings);

  assert.deepEqual(sorted, ['A', 'a', 'b', 'é', '￿', '😀']);
});
