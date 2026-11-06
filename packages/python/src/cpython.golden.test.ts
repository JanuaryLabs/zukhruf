import assert from 'node:assert/strict';
import { test } from 'node:test';

import expected from './fixtures/cpython/expected.json' with { type: 'json' };
import {
  type JsonData,
  NeumaierSum,
  PYTHON_SPACE,
  floatRepr,
  loadsJson,
} from './index.ts';

// fixtures/cpython/expected.json holds what CPython 3.12 gives for each case;
// generate.py writes it. A float crosses as the hex of its 8 bytes, so no
// float is rounded on the way. assert/strict compares numbers as Object.is
// does: -0 is not 0, and any NaN is NaN, whatever its payload bits.
const double = (hex: string): number => Buffer.from(hex, 'hex').readDoubleBE(0);

const bits = (value: number): string => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes.toString('hex');
};

// The oracle came from CPython 3.12, and a loop over an empty list of cases
// would assert nothing, so each test first checks that its cases are there.
const oracle = (cases: readonly unknown[], least: number) => {
  assert.match(expected.python, /^3\.12\./);
  assert.ok(cases.length >= least, `at least ${least} cases`);
};

const loads = expected.loads.filter((load) => 'value' in load);
const refusals = expected.loads.filter((load) => 'error' in load);

const isList = (value: JsonData): value is readonly JsonData[] =>
  Array.isArray(value);

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
  if (isList(value)) return { type: 'list', items: value.map(tagged) };
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
