import assert from 'node:assert/strict';
import { test } from 'node:test';

import fixture from '../fixtures/std/expected.json' with { type: 'json' };
import { std } from '../index.ts';

// fixtures/std/expected.json holds numpy.std of NumPy 2.5.4 for each case,
// with its ddof; std/generate.py makes it. NaN and inf are the strings "NaN"
// and "Infinity". The arrays reach each branch of numpy's pairwise sum, a
// computation from left to right gives other bits for 11 of them, and ddof 1
// gives another value than ddof 0 for each random array.
test('std gives the value of numpy.std for each array and ddof, to the last bit', () => {
  const stds = fixture.cases.map(({ values, ddof }) => std(values, { ddof }));

  assert.deepEqual(
    stds,
    fixture.cases.map((testCase) => Number(testCase.std)),
  );
});

test('std with no ddof gives numpy.std with its default ddof 0', () => {
  const defaults = fixture.cases.filter(({ ddof }) => ddof === 0);

  assert.deepEqual(
    defaults.map(({ values }) => std(values)),
    defaults.map((testCase) => Number(testCase.std)),
  );
});
