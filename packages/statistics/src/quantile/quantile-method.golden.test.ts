import assert from 'node:assert/strict';
import { test } from 'node:test';

import fixture from '../fixtures/expected.json' with { type: 'json' };
import {
  Higher,
  InvertedCdf,
  Linear,
  Lower,
  type QuantileMethod,
} from '../index.ts';

// fixtures/expected.json holds numpy.quantile(values, q, method=...) of NumPy
// 2.5.4 for each array and each q; generate.py makes it. The arrays include
// arange(2000) / 997, whose 0.975 quantile sits at the index
// 1949.0249999999999, and random values where NumPy's linear method gives
// other bits than a + (b - a)t.
const methods: readonly (readonly [
  keyof typeof fixture.expected,
  QuantileMethod,
])[] = [
  ['lower', new Lower()],
  ['higher', new Higher()],
  ['linear', new Linear()],
  ['inverted_cdf', new InvertedCdf()],
];

for (const [name, method] of methods)
  test(`${name} gives the value of numpy.quantile(method='${name}') for each array and q, to the last bit`, () => {
    const values = fixture.arrays.map((sorted) =>
      fixture.qs.map((q) => method.of(sorted, q)),
    );

    assert.deepEqual(values, fixture.expected[name]);
  });

for (const [name, method] of methods)
  test(`${name} refuses a q out of 0 to 1 and refuses no values, as NumPy does`, () => {
    for (const q of [-0.01, 1.01, Number.NaN])
      assert.throws(() => method.of([1, 2, 3], q), {
        name: 'RangeError',
        message: /^A quantile is from 0 to 1/,
      });
    assert.throws(() => method.of([], 0.5), {
      name: 'RangeError',
      message: /^A quantile needs at least one value/,
    });
  });
