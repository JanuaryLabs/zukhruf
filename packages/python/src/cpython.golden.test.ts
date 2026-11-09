import assert from 'node:assert/strict';
import { test } from 'node:test';

import expected from './fixtures/cpython/expected.json' with { type: 'json' };
import {
  type JsonData,
  NeumaierSum,
  PYTHON_SPACE,
  PYTHON_WORD,
  floatRepr,
  loadsJson,
} from './index.ts';

// fixtures/cpython/expected.json holds what CPython 3.12 gives for each case;
// generate.py writes it. A float crosses as the hex of its 8 bytes, so no
// float is rounded on the way. assert/strict compares numbers as Object.is
// does: -0 is not 0, and any NaN is NaN, whatever its payload bits.
const double = (hex: string): number =>
  new DataView(Uint8Array.fromHex(hex).buffer).getFloat64(0);

const bits = (value: number): string => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes.toHex();
};

// The oracle came from CPython 3.12, and a loop over an empty list of cases
// would assert nothing, so each test first checks that its cases are there.
const oracle = (cases: readonly unknown[], least: number) => {
  assert.match(expected.python, /^3\.12\./);
  assert.ok(cases.length >= least, `at least ${least} cases`);
};

const loads = expected.loads.filter((load) => 'value' in load);
const refusals = expected.loads.filter((load) => 'error' in load);

// A value with its Python type written out, as generate.py writes it.
const tagged = (value: JsonData): unknown => {
  if (value === null || typeof value === 'boolean')
    return { type: 'constant', value };
  if (typeof value === 'bigint') return { type: 'int', digits: String(value) };
  if (typeof value === 'number') return { type: 'float', bits: bits(value) };
  if (typeof value === 'string')
    return {
      type: 'str',
      code_points: [...value].map((char) => char.codePointAt(0)),
    };
  if (Array.isArray(value)) return { type: 'list', items: value.map(tagged) };
  return {
    type: 'dict',
    items: [...value].map(([key, item]) => [key, tagged(item)]),
  };
};

test('NeumaierSum.of gives the sum() of CPython 3.12 to the last bit', () => {
  oracle(expected.sums, 200);

  for (const [index, sum] of expected.sums.entries())
    assert.equal(
      NeumaierSum.of(sum.values.map(double)),
      double(sum.sum),
      `sum ${index}`,
    );
});

test('a running NeumaierSum gives the sum() of CPython 3.12 after each value', () => {
  oracle(expected.sums, 200);

  for (const [index, sum] of expected.sums.entries()) {
    const running = new NeumaierSum();
    const values = sum.values.map((value) => {
      running.add(double(value));
      return running.value;
    });

    assert.deepEqual(values, sum.prefixes.map(double), `sum ${index}`);
  }
});

const means = expected.sums.filter((sum) => sum.mean !== 'ZeroDivisionError');
const meanRefusals = expected.sums.filter(
  (sum) => sum.mean === 'ZeroDivisionError',
);

// Each mean takes its values from a one-pass iterator, as report.ts of
// @zukhruf/mteb gives the values of a Map, so a mean that reads them twice
// or that counts them apart fails.
test('NeumaierSum.mean throws a RangeError for no value, where sum(values) / len(values) raises ZeroDivisionError in CPython 3.12', () => {
  oracle(meanRefusals, 1);

  for (const sum of meanRefusals)
    assert.throws(
      () => NeumaierSum.mean(sum.values.map(double).values()),
      RangeError,
    );
});

test('NeumaierSum.mean gives sum(values) / len(values) of CPython 3.12 to the last bit, not the math.fsum of statistics.fmean', () => {
  oracle(means, 200);

  for (const [index, sum] of means.entries())
    assert.equal(
      NeumaierSum.mean(sum.values.map(double).values()),
      double(sum.mean),
      `mean ${index}`,
    );
});

test('floatRepr gives the repr() of a float in CPython 3.12', () => {
  oracle(expected.reprs, 2500);

  for (const { bits: hex, repr } of expected.reprs)
    assert.equal(floatRepr(double(hex)), repr);
});

test('loadsJson gives the value of json.loads: key order, repeated keys, int and float, NaN tokens, big ints and lone surrogates', () => {
  oracle(loads, 20);

  for (const load of loads)
    assert.deepEqual(tagged(loadsJson(load.text)), load.value, load.text);
});

test('loadsJson refuses each text that json.loads refuses: a SyntaxError for a JSONDecodeError, a RangeError for an int of more than 4300 digits', () => {
  oracle(refusals, 20);

  for (const load of refusals)
    assert.throws(
      () => loadsJson(load.text),
      load.error === 'ValueError' ? RangeError : SyntaxError,
      load.text.slice(0, 40),
    );
});

test('PYTHON_SPACE holds exactly the characters of str.isspace() in CPython 3.12', () => {
  oracle(expected.isspace, 29);
  const space = new RegExp(`^[${PYTHON_SPACE}]$`, 'u');
  const codePoints: number[] = [];
  for (let code = 0; code <= 0x10ffff; code++)
    if (space.test(String.fromCodePoint(code))) codePoints.push(code);

  assert.deepEqual(codePoints, expected.isspace);
});

// Each [first, last] run of code points that generate.py wrote, as a set.
const codesOf = (runs: readonly (readonly number[])[]): Set<number> => {
  const codes = new Set<number>();
  for (const [first, last] of runs) {
    if (typeof first !== 'number' || typeof last !== 'number')
      throw new TypeError(
        `Expected a [first, last] run, got ${first}, ${last}`,
      );
    for (let code = first; code <= last; code++) codes.add(code);
  }
  return codes;
};

test('PYTHON_WORD holds exactly the characters of \\w in CPython 3.12, for each code point that its Unicode database assigns', () => {
  oracle(expected.word, 700);
  const word = new RegExp(`^[${PYTHON_WORD}]$`, 'u');
  const unassigned = codesOf(expected.unassigned);
  const python = codesOf(expected.word);
  const differ: number[] = [];
  for (let code = 0; code <= 0x10ffff; code++)
    if (
      !unassigned.has(code) &&
      word.test(String.fromCodePoint(code)) !== python.has(code)
    )
      differ.push(code);

  assert.equal(expected.unicode, '15.0.0');
  assert.deepEqual(differ, []);
});
