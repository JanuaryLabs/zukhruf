import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { gammaln } from './scipy.ts';

// fixtures/gammaln/expected.json holds scipy.special.gammaln of SciPy 1.18.1
// for each integer from 1 to 4097 and for larger x. fixtures/gammaln/generate.py
// makes it.
const expected: { readonly gammaln: readonly [x: number, value: number][] } =
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures/gammaln/expected.json'),
      'utf8',
    ),
  );

// The number of floats between two positive floats.
function ulps(a: number, b: number): bigint {
  const bits = new BigInt64Array(new Float64Array([a, b]).buffer);
  const difference = (bits[0] ?? 0n) - (bits[1] ?? 0n);
  return difference < 0n ? -difference : difference;
}

// SciPy calls the log of the C library, and this package does not, so a
// value can differ from SciPy in its last bit.
test(`gammaln gives the value of SciPy within 1 ulp for ${expected.gammaln.length} values of x from 1 to 2^53`, () => {
  const far = expected.gammaln.filter(
    ([x, value]) => ulps(gammaln(x), value) > 1n,
  );

  assert.deepEqual(far, []);
});
