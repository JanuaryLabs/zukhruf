import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RandomState, defaultRng } from './index.ts';

// NumPy gives numbers for these calls, by paths that the golden fixture does
// not prove. The port throws a RangeError, so it never gives numbers that
// NumPy does not give. The golden fixture proves the range 2^32, the choice
// of a 50th of 20,000, and the choice of 250 of 10,000.

test('Generator.integers with a range of 2^32 + 1 throws a RangeError, where NumPy draws 64 bits', () => {
  const generator = defaultRng(0);

  assert.throws(() => generator.integers(0, 2 ** 32 + 1, 1), {
    name: 'RangeError',
  });
});

test('RandomState.randint with a range of 2^32 + 1 throws a RangeError, where NumPy draws 64 bits', () => {
  const generator = new RandomState(0);

  assert.throws(() => generator.randint(-1, 2 ** 32, 1), {
    name: 'RangeError',
  });
});

test('Generator.choice of more than a 50th of a population above 10,000 throws a RangeError, where NumPy shuffles the tail of a permutation', () => {
  const generator = defaultRng(0);
  const population = Array.from({ length: 20_000 }, (_, index) => index);

  assert.throws(() => generator.choice(population, 401, { replace: false }), {
    name: 'RangeError',
  });
});

test('Generator.choice of more than a 50th of 10,001 throws a RangeError, where NumPy shuffles the tail of a permutation', () => {
  const generator = defaultRng(0);
  const population = Array.from({ length: 10_001 }, (_, index) => index);

  assert.throws(() => generator.choice(population, 201, { replace: false }), {
    name: 'RangeError',
  });
});
