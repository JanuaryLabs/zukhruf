import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NumpyGenerator } from './numpy-random.ts';

// The values come from numpy 2.3.4: numpy.random.default_rng(seed).integers.
test('a generator gives the integers of numpy.random.default_rng for the same seed and the same calls', () => {
  const generator = new NumpyGenerator(31957);

  const draws = [
    generator.integers(0, 10, 12),
    generator.integers(0, 3, 5),
    generator.integers(0, 1675, 6),
    generator.integers(0, 7, 4),
  ];

  assert.deepEqual(draws, [
    [6, 1, 6, 2, 4, 1, 2, 1, 3, 4, 9, 8],
    [1, 1, 1, 0, 1],
    [796, 323, 251, 1607, 113, 46],
    [4, 5, 5, 0],
  ]);
});

test('a seed above 2^32 gives the integers of numpy', () => {
  const generator = new NumpyGenerator(2 ** 40 + 5);

  assert.deepEqual(generator.integers(0, 1000, 5), [14, 4, 449, 372, 915]);
});
