import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import fixture from '../fixtures/holm/expected.json' with { type: 'json' };
import { Holm } from '../index.ts';

// fixtures/holm/expected.json holds the adjusted p-values of statsmodels
// 0.15.0 multipletests(p, method="holm")[1] for each case; holm/generate.py
// makes it. The cases reach each rule of the step-down correction: the order
// of the p-values, ties, the cap at 1, and the running maximum.
void test.each(fixture.cases, ({ case: name, p, adjusted }) =>
  test(`Holm adjusts the p-values of "${name}" as multipletests of statsmodels with method holm, to the last bit`, () => {
    const actual = new Holm().adjust(p);

    assert.deepEqual(actual, adjusted);
  }),
);
