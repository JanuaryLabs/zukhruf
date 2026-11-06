import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadsJson, toJsonParseValue } from './index.ts';

// The entries of each object in order, because deepEqual does not compare the
// order of keys. A Map has no own entries, so a Map left in a value differs.
const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).map(([key, item]) => [key, ordered(item)]);
  return value;
};

test('toJsonParseValue gives what JSON.parse gives for the same text: integer-like keys first, an own __proto__ key, nested values, and the nearest number for an int beyond 2^53', () => {
  const texts = [
    '{"b": 1, "10": 2.0, "2": 1.0, "a": 3}',
    '{"__proto__": {"x": 1}}',
    '[{"a": [1, {"b": 2.5}]}, 3]',
    '[18446744073709551617, -9007199254740993, 12345678901234567890]',
    '{"a": {"a": 1}, "a": 2}',
    '-0.0',
    '"text"',
    'true',
    'null',
  ];

  for (const text of texts) {
    const value = toJsonParseValue(loadsJson(text));

    assert.deepEqual(value, JSON.parse(text), text);
    assert.deepEqual(ordered(value), ordered(JSON.parse(text)), text);
  }
});

test('toJsonParseValue gives 0 for the int -0, where JSON.parse gives -0: an int of Python has no negative zero', () => {
  const value = toJsonParseValue(loadsJson('-0'));

  assert.equal(value, 0);
});

test('toJsonParseValue keeps the NaN, Infinity and -Infinity tokens of Python as numbers, at the root and inside lists and objects', () => {
  const root = toJsonParseValue(loadsJson('NaN'));
  const nested = toJsonParseValue(
    loadsJson('[NaN, {"a": Infinity, "b": [-Infinity]}]'),
  );

  assert.equal(root, NaN);
  assert.deepEqual(nested, [NaN, { a: Infinity, b: [-Infinity] }]);
});
