import assert from 'node:assert/strict';
import { test } from 'node:test';

import { F1, Precision, Recall, ScorerSet } from '../../index.ts';
import {
  ComparisonSpec,
  JsonSchema,
  PythonEquality,
  TextVarsCase,
  TreeWalk,
  ValueMatches,
} from '../index.ts';

test('by default ValueMatches compares leaves by JSON equality: 1 agrees with 1.0 and 2 with 2.0, true does not agree with 1, an int and a float only when they are the same number exactly, and "1" is not 1', () => {
  const scorer = new ScorerSet(
    { recall: new Recall(new ValueMatches()) },
    { comparer: new TreeWalk() },
  );
  const testCase = new TextVarsCase({
    schema: (value) => new JsonSchema(value, { draft: '7' }),
  }).from({
    expected:
      '{"t": 1, "z": 0, "f": 1, "g": 2.0, "big": 9007199254740993, "s": 1, "n": null, "x": "a", "b": true}',
    schema: { type: 'object' },
  });

  const scorecard = scorer.score(
    '{"t": true, "z": false, "f": 1.0, "g": 2, "big": 9007199254740992.0, "s": "1", "n": null, "x": "a", "b": true}',
    testCase,
  );

  const ratio = scorecard.ratios.get('recall');
  assert.deepEqual([ratio?.part, ratio?.whole], [5, 9]);
});

test("with PythonEquality in the spec, ValueMatches compares leaves as Python's == does: True == 1 == 1.0, False == 0, an int and a float only when they are the same number exactly, and '1' is not 1", () => {
  const scorer = new ScorerSet(
    { recall: new Recall(new ValueMatches()) },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({ comparator: new PythonEquality() }),
      ),
    },
  );
  const testCase = new TextVarsCase({
    schema: (value) => new JsonSchema(value, { draft: '7' }),
  }).from({
    expected:
      '{"t": 1, "z": 0, "f": 1, "tf": 1.0, "big": 9007199254740993, "s": 1, "n": null, "x": "a"}',
    schema: { type: 'object' },
  });

  const scorecard = scorer.score(
    '{"t": true, "z": false, "f": 1.0, "tf": true, "big": 9007199254740992.0, "s": "1", "n": null, "x": "a"}',
    testCase,
  );

  const ratio = scorecard.ratios.get('recall');
  assert.deepEqual([ratio?.part, ratio?.whole], [6, 8]);
});

test('Precision, Recall and F1 of ValueMatches count the leaf pairs whose two values are equal, of the stated leaves, of the expected leaves, and as 2·hits of stated + expected', () => {
  const scorer = new ScorerSet(
    {
      precision: new Precision(new ValueMatches()),
      recall: new Recall(new ValueMatches()),
      f1: new F1(new ValueMatches()),
    },
    { comparer: new TreeWalk() },
  );
  const testCase = new TextVarsCase({
    schema: (value) => new JsonSchema(value, { draft: '7' }),
  }).from({
    expected: '{"a": 1, "b": 2, "c": 3}',
    schema: { type: 'object' },
  });

  const scorecard = scorer.score('{"a": 1, "b": 3, "d": 4, "e": 5}', testCase);

  assert.deepEqual(
    ['precision', 'recall', 'f1'].map((name) => {
      const ratio = scorecard.ratios.get(name);
      return [ratio?.part, ratio?.whole];
    }),
    [
      [1, 4],
      [1, 3],
      [2, 7],
    ],
  );
});
