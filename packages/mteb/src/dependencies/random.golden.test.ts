import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PythonRandom } from './python-random.ts';

// fixtures/random/expected.json holds what CPython 3.12.9's random.Random
// returned for a list of calls from a seed. generate.py makes it.
type Call = readonly [string, ...number[]];

type Case = {
  readonly case: string;
  readonly seed: number;
  readonly calls: readonly Call[];
  readonly results: readonly number[][];
};

const expected: { readonly python: Case[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/random/expected.json'),
    'utf8',
  ),
);

for (const pythonCase of expected.python)
  test(`random.Random(${pythonCase.seed}) gives the draws of CPython: ${pythonCase.case}`, () => {
    const generator = new PythonRandom(pythonCase.seed);

    const results = pythonCase.calls.map(([name, a = 0, b = 0]) => {
      if (name === 'sample') return generator.sample(a, b);
      if (name === 'choices') return generator.choices(a, b);
      throw new Error(`No call ${name}.`);
    });

    assert.deepEqual(results, pythonCase.results);
  });

test('a sample larger than the population throws, as CPython raises a ValueError', () => {
  const generator = new PythonRandom(1);

  assert.throws(() => generator.sample(3, 4), {
    message: 'Sample larger than population or is negative',
  });
});

test('a negative sample size throws, as CPython raises a ValueError', () => {
  const generator = new PythonRandom(1);

  assert.throws(() => generator.sample(5, -1), {
    name: 'RangeError',
    message: 'Sample larger than population or is negative',
  });
});

test('a float seed throws a TypeError: MTEB seeds random.Random with an int', () => {
  assert.throws(() => new PythonRandom(1.5), { name: 'TypeError' });
});
