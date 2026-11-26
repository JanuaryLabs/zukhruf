import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import fixture from './fixtures/expected.json' with { type: 'json' };
import {
  Generator,
  MT19937,
  PCG64,
  RandomState,
  SeedSequence,
  defaultRng,
} from './index.ts';

// fixtures/expected.json holds what numpy.random of NumPy 2.5.4 returned for
// a list of calls from a seed, and the calls for which it raised.
// generate.py makes it. A seed of 2^53 or more is a decimal string.
const seedOf = (seed: number | string): number | bigint =>
  typeof seed === 'string' ? BigInt(seed) : seed;

// A call of the fixture: its name, then its numbers. A NaN weight is the
// string "NaN".
const parse = (call: readonly (string | number)[]): [string, number[]] => {
  const [name, ...args] = call;
  if (typeof name !== 'string') throw new TypeError(`No call ${name}`);
  return [
    name,
    args.map((arg) => {
      if (arg === 'NaN') return Number.NaN;
      if (typeof arg !== 'number') throw new TypeError(`No number ${arg}`);
      return arg;
    }),
  ];
};

const range = (n: number) => Array.from({ length: n }, (_, index) => index);
const array = (n: number) => range(n).map((index) => 3 * index + 1);
const float32Weights = (n: number) =>
  new Float32Array(n).fill(Math.fround(1 / n));

void test.each(fixture.seed_sequence, (sequenceCase) =>
  test(`SeedSequence(${sequenceCase.seed}).generateState gives the words of NumPy: ${sequenceCase.case}`, () => {
    const sequence = new SeedSequence(seedOf(sequenceCase.seed));

    const words = sequence.generateState(sequenceCase.n_words);

    assert.deepEqual([...words], sequenceCase.words);
  }),
);

void test.each(fixture.pcg64, (pcgCase) =>
  test.each(
    [
      ['a seed', () => new PCG64(seedOf(pcgCase.seed))],
      [
        'a SeedSequence',
        () => new PCG64(new SeedSequence(seedOf(pcgCase.seed))),
      ],
    ] as const,
    ([form, make]) =>
      test(`PCG64 of ${form} gives the low, then the high half of each 64-bit output of NumPy: ${pcgCase.case}`, () => {
        const bits = make();

        const words = pcgCase.words.map(() => bits.nextUint32());

        assert.deepEqual(words, pcgCase.words);
      }),
  ),
);

void test.each(fixture.mt19937, (mtCase) =>
  test(`MT19937.legacy(${mtCase.seed}) gives the words of NumPy: ${mtCase.case}`, () => {
    const bits = MT19937.legacy(mtCase.seed);

    const words = mtCase.words.map(() => bits.nextUint32());

    assert.deepEqual(words, mtCase.words);
  }),
);

void test.each(fixture.random_state, (stateCase) =>
  test.each(
    [
      ['a seed', () => new RandomState(stateCase.seed)],
      ['an MT19937', () => new RandomState(MT19937.legacy(stateCase.seed))],
    ] as const,
    ([form, make]) =>
      test(`RandomState of ${form} gives the draws of NumPy: ${stateCase.case}`, () => {
        const generator = make();

        const results = stateCase.calls.map((call) => {
          const [name, [a = 0, b = 0, c = 0, ...weights]] = parse(call);
          if (name === 'randint') return generator.randint(a, b, c);
          if (name === 'choice_weights32')
            return generator.choice(a, b, {
              p: new Float32Array([c, ...weights]),
            });
          if (name === 'random_sample') return generator.randomSample(a);
          if (name === 'uniform') return generator.uniform(a);
          if (name === 'choice_p')
            return generator.choice(a, b, { p: float32Weights(a) });
          if (name === 'choice_no_replace')
            return generator.choice(a, b, { replace: false });
          if (name === 'choice') return generator.choice(array(a), b);
          if (name === 'choice_array_p')
            return generator.choice(array(a), b, { p: float32Weights(a) });
          if (name === 'choice_array_no_replace')
            return generator.choice(array(a), b, { replace: false });
          if (name === 'permutation') return generator.permutation(a);
          if (name === 'shuffle') {
            const values = range(a);
            generator.shuffle(values);
            return values;
          }
          throw new Error(`No call ${name}`);
        });

        assert.deepEqual(results, stateCase.results);
      }),
  ),
);

void test.each(fixture.generator_cases, (generatorCase) =>
  test(`Generator over ${generatorCase.bits} of the seed ${generatorCase.seed} gives the draws of NumPy: ${generatorCase.case}`, () => {
    const seed = seedOf(generatorCase.seed);
    const generator =
      generatorCase.bits === 'pcg64'
        ? defaultRng(seed)
        : new Generator(MT19937.legacy(seed));

    const results = generatorCase.calls.map((call) => {
      const [name, [a = 0, b = 0, c = 0]] = parse(call);
      if (name === 'integers') return generator.integers(a, b, c);
      if (name === 'random') return generator.random(a);
      if (name === 'shuffle') {
        const values = range(a);
        generator.shuffle(values);
        return values;
      }
      if (name === 'permutation') return generator.permutation(a);
      if (name === 'permutation_list') return generator.permutation(array(a));
      if (name === 'choice_no_replace')
        return generator.choice(range(a), b, { replace: false });
      if (name === 'choice') return generator.choice(a, b);
      if (name === 'choice_array') return generator.choice(array(a), b);
      if (name === 'choice_n_no_replace')
        return generator.choice(a, b, { replace: false });
      throw new Error(`No call ${name}`);
    });

    assert.deepEqual(results, generatorCase.results);
  }),
);

// NumPy's ValueError is a RangeError here, with NumPy's message; its
// TypeError is a TypeError, whose message names NumPy's dtypes and is not
// kept.
const errorNames: Record<string, string> = {
  ValueError: 'RangeError',
  TypeError: 'TypeError',
};

// The forms of a seed that the refusal is given in: a number and a bigint for
// an integer, a bigint for a seed of 2^53 or more, a number for a float.
const seedForms = (seed: number | string): (number | bigint)[] => {
  if (typeof seed === 'string') return [BigInt(seed)];
  return Number.isInteger(seed) ? [seed, BigInt(seed)] : [seed];
};

const makers: Record<string, (seed: number | bigint) => unknown> = {
  default_rng: (seed) => defaultRng(seed),
  SeedSequence: (seed) => new SeedSequence(seed),
  PCG64: (seed) => new PCG64(seed),
  MT19937: (seed) => MT19937.legacy(seed),
  RandomState: (seed) => new RandomState(seed),
};

void test.each(fixture.refusals, (refusal) =>
  test.each(seedForms(refusal.seed), (seed) =>
    test(`${refusal.case} throws a ${errorNames[refusal.raises]}, as NumPy raises a ${refusal.raises} (seed ${typeof seed} ${seed})`, () => {
      const make = makers[refusal.make];
      if (make === undefined) throw new Error(`No maker ${refusal.make}`);

      const act = () => {
        const generator = make(seed);
        if (refusal.call === null) return;
        const [name, [a = 0, b = 0, c = 0, ...weights]] = parse(refusal.call);
        if (generator instanceof Generator) {
          if (name === 'integers') return generator.integers(a, b, c);
          if (name === 'choice_no_replace')
            return generator.choice(range(a), b, { replace: false });
          if (name === 'choice') return generator.choice(array(a), b);
          if (name === 'choice_n') return generator.choice(a, b);
        }
        if (generator instanceof RandomState) {
          if (name === 'randint') return generator.randint(a, b, c);
          if (name === 'choice_no_replace')
            return generator.choice(a, b, { replace: false });
          if (name === 'choice') return generator.choice(array(a), b);
          if (name === 'choice_n') return generator.choice(a, b);
          if (name === 'choice_weights')
            return generator.choice(a, b, { p: [c, ...weights] });
          if (name === 'choice_weights32')
            return generator.choice(a, b, {
              p: new Float32Array([c, ...weights]),
            });
        }
        throw new Error(`No call ${name} on ${refusal.make}`);
      };

      assert.throws(
        act,
        refusal.raises === 'ValueError'
          ? { name: 'RangeError', message: refusal.message }
          : { name: 'TypeError' },
      );
    }),
  ),
);
