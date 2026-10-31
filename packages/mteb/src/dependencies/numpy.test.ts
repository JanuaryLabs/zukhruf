import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addReduceat, meanFloat32, sumFloat32 } from './numpy.ts';

// NumPy 2.5.4 np.add.reduceat raised these IndexErrors.
for (const [values, starts, message] of [
  [[1, 2, 3, 4, 5], [0, 5], 'index 5 out-of-bounds in add.reduceat [0, 5)'],
  [[1, 2, 3, 4, 5], [0, -1], 'index -1 out-of-bounds in add.reduceat [0, 5)'],
  [[], [0], 'index 0 out-of-bounds in add.reduceat [0, 0)'],
] as const)
  test(`addReduceat refuses the starts ${JSON.stringify(starts)} of ${values.length} values, as numpy raises`, () => {
    assert.throws(() => addReduceat(values, starts), {
      name: 'RangeError',
      message,
    });
  });

// No caller of this package sums float32 negative zeros, so this test calls
// the numpy port itself. NumPy 2.5.4 gave 0.0, not -0.0, for np.sum and
// np.mean of np.full(n, -0.0, dtype=np.float32) for each n here, and 0.0 for
// np.sum of no values.
test('sumFloat32 and meanFloat32 of float32 negative zeros give 0, not -0, as np.sum and np.mean do', () => {
  const lengths = [1, 7, 8, 9, 128, 129, 300];

  const sums = [0, ...lengths].map((n) =>
    sumFloat32(new Float32Array(n).fill(-0)),
  );
  const means = lengths.map((n) => meanFloat32(new Float32Array(n).fill(-0)));

  assert.deepEqual(
    { sums, means },
    { sums: [0, ...lengths.map(() => 0)], means: lengths.map(() => 0) },
  );
});
