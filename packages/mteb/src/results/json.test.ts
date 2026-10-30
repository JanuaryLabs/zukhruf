import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pythonFloatRepr } from '../dependencies/python.ts';
import {
  jsonLoadsInOrder,
  pydanticJsonDumps,
  pythonJsonDumps,
  pythonJsonLoads,
} from './json.ts';

// Python 3.12 printed these with json.dumps(value, indent=2) and repr().
test('pythonJsonDumps indents like json.dump, keeps empty containers on one line and writes NaN as a token', () => {
  const value = { a: [], b: {}, c: [1, 2], d: NaN, e: 'é\u007f' };

  const text = pythonJsonDumps(value, { indent: 2 });

  assert.equal(
    text,
    '{\n  "a": [],\n  "b": {},\n  "c": [\n    1,\n    2\n  ],\n  "d": NaN,\n  "e": "\\u00e9\\u007f"\n}',
  );
});

test('pythonJsonDumps separates items with ", " and ": " without an indent', () => {
  const value = { task: 't', splits: ['test'], version: { mteb: null } };

  const text = pythonJsonDumps(value);

  assert.equal(
    text,
    '{"task": "t", "splits": ["test"], "version": {"mteb": null}}',
  );
});

test('pythonJsonDumps writes the infinities and escapes an astral character as two surrogates', () => {
  const value = [Infinity, -Infinity, '😀', 'a"b\\c\n'];

  const text = pythonJsonDumps(value);

  assert.equal(
    text,
    '[Infinity, -Infinity, "\\ud83d\\ude00", "a\\"b\\\\c\\n"]',
  );
});

test('pythonFloatRepr gives the repr of Python for the positional and the scientific range', () => {
  const values = [
    2.749999111983925e-6, 1e16, 0.0001, 1.5e-5, 0.96995, 123.5, -0.5,
  ];

  const reprs = values.map(pythonFloatRepr);

  assert.deepEqual(reprs, [
    '2.749999111983925e-06',
    '1e+16',
    '0.0001',
    '1.5e-05',
    '0.96995',
    '123.5',
    '-0.5',
  ]);
});

test('pythonJsonLoads reads the NaN and Infinity tokens and leaves the same words inside strings', () => {
  const text = '{"a": NaN, "b": [-Infinity, Infinity], "c": "NaN: Infinity"}';

  const value = pythonJsonLoads(text);

  assert.deepEqual(value, {
    a: NaN,
    b: [-Infinity, Infinity],
    c: 'NaN: Infinity',
  });
});

// CPython 3.12 json.loads raises "Expecting property name enclosed in double
// quotes" for each of these: the tokens are values only.
for (const text of [
  '{NaN: 1}',
  '{Infinity: 1}',
  '{-Infinity: 1}',
  '{"a": {NaN: 1}}',
])
  for (const [name, load] of [
    ['pythonJsonLoads', pythonJsonLoads],
    ['jsonLoadsInOrder', jsonLoadsInOrder],
  ] as const)
    test(`${name} refuses ${text}, a token in the place of a key`, () => {
      assert.throws(() => load(text), { name: 'SyntaxError' });
    });

test('pydanticJsonDumps writes NaN as null, a date as an ISO string and keeps characters outside ASCII', () => {
  const value = {
    score: NaN,
    date: new Date('2026-10-28T08:12:02.003Z'),
    name: 'é',
  };

  const text = pydanticJsonDumps(value);

  assert.equal(
    text,
    '{\n  "score": null,\n  "date": "2026-10-28T08:12:02.003Z",\n  "name": "é"\n}',
  );
});
