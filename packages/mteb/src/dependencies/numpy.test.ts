import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addReduceat } from './numpy.ts';

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
