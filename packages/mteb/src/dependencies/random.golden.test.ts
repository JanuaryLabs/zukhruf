import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { NumpyGenerator, RandomState } from './numpy-random.ts';
import { PythonRandom } from './python-random.ts';

// fixtures/random/expected.json holds what CPython 3.12.9's random.Random,
// numpy 2.5.4's legacy RandomState and numpy's default_rng returned for a
// list of calls from a seed. generate.py makes it.
type Call = readonly [string, ...number[]];

type Case = {
  readonly case: string;
  readonly seed: number;
  readonly calls: readonly Call[];
  readonly results: readonly number[][];
};

const expected: {
  readonly python: Case[];
  readonly numpy: Case[];
  readonly generator_cases: Case[];
} = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/random/expected.json'),
    'utf8',
  ),
);

function float32Weights(n: number): Float32Array {
  return new Float32Array(n).fill(Math.fround(1 / n));
}

for (const pythonCase of expected.python)
  test(`random.Random(${pythonCase.seed}) gives the draws of CPython: ${pythonCase.case}`, () => {
    const generator = new PythonRandom(pythonCase.seed);

    const results = pythonCase.calls.map(([name, a = 0, b = 0]) => {
      if (name === 'sample') return generator.sample(a, b);
      if (name === 'choices') return generator.choices(a, b);
      if (name === 'random')
        return Array.from({ length: a }, () => generator.random());
      if (name === 'getrandbits')
        return Array.from({ length: b }, () => generator.getrandbits(a));
      throw new Error(`No call ${name}.`);
    });

    assert.deepEqual(results, pythonCase.results);
  });

for (const numpyCase of expected.numpy)
  test(`RandomState(${numpyCase.seed}) gives the draws of numpy: ${numpyCase.case}`, () => {
    const generator = new RandomState(numpyCase.seed);

    const results = numpyCase.calls.map(([name, a = 0, b = 0, c = 0]) => {
      if (name === 'randint') return generator.randint(a, b, c);
      if (name === 'random_sample') return generator.randomSample(a);
      if (name === 'uniform') return generator.uniform(a);
      if (name === 'choice_p')
        return generator.choiceWithProbabilities(float32Weights(a), b);
      if (name === 'choice_no_replace')
        return generator.choiceWithoutReplacement(a, b);
      if (name === 'choice')
        return generator.choice(
          Array.from({ length: a }, (_, index) => 3 * index + 1),
          b,
        );
      if (name === 'permutation') return generator.permutation(a);
      if (name === 'shuffle') {
        const values = Array.from({ length: a }, (_, index) => index);
        generator.shuffle(values);
        return values;
      }
      throw new Error(`No call ${name}.`);
    });

    assert.deepEqual(results, numpyCase.results);
  });

for (const generatorCase of expected.generator_cases)
  test(`default_rng(${generatorCase.seed}) gives the draws of numpy: ${generatorCase.case}`, () => {
    const generator = new NumpyGenerator(generatorCase.seed);

    const results = generatorCase.calls.map(([name, a = 0, b = 0, c = 0]) => {
      if (name === 'integers') return generator.integers(a, b, c);
      if (name === 'shuffle') {
        const values = Array.from({ length: a }, (_, index) => index);
        generator.shuffle(values);
        return values;
      }
      if (name === 'permutation') return generator.permutation(a);
      if (name === 'permutation_list')
        return generator.permutation(
          Array.from({ length: a }, (_, index) => 3 * index + 1),
        );
      if (name === 'choice_no_replace')
        return generator.choiceWithoutReplacement(
          Array.from({ length: a }, (_, index) => index),
          b,
        );
      throw new Error(`No call ${name}.`);
    });

    assert.deepEqual(results, generatorCase.results);
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

test('getrandbits of more than 32 bits throws, as the draws are numbers', () => {
  const generator = new PythonRandom(1);

  assert.throws(() => generator.getrandbits(33), { name: 'RangeError' });
});
