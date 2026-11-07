import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BrierScore, LabelCase, ProbabilityComparer } from './index.ts';

const compare = (stated: unknown, expected: number | string | string[]) =>
  new ProbabilityComparer().compare(
    stated,
    new LabelCase({ expected, weight: 1 }),
  );

test('ProbabilityComparer reads the probability of each label from JSON text, a plain object or a Map, and a key is a number label when the expected label is a number', () => {
  assert.deepEqual(
    compare('{"1": 0.25, "0": 0.75}', 1).probabilities,
    new Map([
      [0, 0.75],
      [1, 0.25],
    ]),
  );
  assert.deepEqual(
    [...compare({ yes: 0.5 }, 'yes').probabilities],
    [['yes', 0.5]],
  );
  assert.deepEqual(
    [...compare(new Map([['1', 0.5]]), '1').probabilities],
    [['1', 0.5]],
  );
});

test('ProbabilityComparer refuses a probability outside [0, 1], an answer that is not an object, and a case of more than one expected label', () => {
  assert.throws(
    () => compare({ a: 1.5 }, 'a'),
    /The probability of "a" is a number in \[0, 1\], not 1.5/,
  );
  assert.throws(
    () => compare('[0.5]', 'a'),
    /the probability of each label, as an object/,
  );
  assert.throws(
    () => compare({ a: 0.5 }, ['a', 'b']),
    /one expected label, not \["a","b"\]/,
  );
});

test('BrierScore refuses an answer without the probability of the positive label or of the expected label, and weights that are not one for each answer', () => {
  const answer = compare({ a: 0.5, b: 0.5 }, 'a');
  const other = compare({ b: 1 }, 'a');

  assert.throws(
    () => new BrierScore({ positiveLabel: 'c' }).score(answer),
    /no probability of the positive label "c"/,
  );
  assert.throws(
    () => new BrierScore().score(other),
    /no probability of the expected label "a"/,
  );
  assert.throws(
    () => new BrierScore().mean([answer], [1, 1]),
    /have 1 and 2 values/,
  );
});
