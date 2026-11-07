import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Precision, Ratio, Recall, ScorerSet } from '../../index.ts';
import {
  AllMatched,
  ConfigCase,
  JsonSchema,
  JsonValue,
  PathMatches,
  TokenF1,
  TreeWalk,
  TypePrecision,
  ValueMatches,
} from '../index.ts';

test('with nullIsMissing, PathMatches and ValueMatches read a null as no value on both sides, as the table of the README counts; without it a null is a value', () => {
  const scorer = (nullIsMissing: boolean) =>
    new ScorerSet(
      {
        'value recall': new Recall(new ValueMatches({ nullIsMissing })),
        'value precision': new Precision(new ValueMatches({ nullIsMissing })),
        'path recall': new Recall(new PathMatches({ nullIsMissing })),
        'path precision': new Precision(new PathMatches({ nullIsMissing })),
      },
      { comparer: new TreeWalk() },
    );
  // same value, another value, no stated value, no expected value, neither.
  const stated = { same: 1, other: 2, gone: null, extra: 3, none: null };
  const testCase = new ConfigCase().from({
    expected: { same: 1, other: 1, gone: 4, extra: null, none: null },
  });

  const ratios = (nullIsMissing: boolean) =>
    Object.fromEntries(scorer(nullIsMissing).score(stated, testCase).ratios);

  assert.deepEqual(ratios(true), {
    'value recall': new Ratio(1, 3),
    'value precision': new Ratio(1, 3),
    'path recall': new Ratio(2, 3),
    'path precision': new Ratio(2, 3),
  });
  assert.deepEqual(ratios(false), {
    'value recall': new Ratio(2, 5),
    'value precision': new Ratio(2, 5),
    'path recall': new Ratio(5, 5),
    'path precision': new Ratio(5, 5),
  });
});

test('with nullIsMissing, TokenF1 leaves out an expected null and reads a stated null as absentAs, and TypePrecision leaves out a stated null', () => {
  const schema = new JsonSchema(
    JsonValue.from({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    }),
  );
  const scorer = (nullIsMissing: boolean) =>
    new ScorerSet(
      {
        tokens: new TokenF1({ whenNoWords: 1, absentAs: 'x', nullIsMissing }),
        types: new TypePrecision({ nullIsMissing }),
      },
      { comparer: new TreeWalk() },
    );
  const testCase = new ConfigCase({ schema }).from({
    expected: { a: 'x', b: null },
  });

  const missing = scorer(true).score({ a: null, b: 'y' }, testCase);
  const value = scorer(false).score({ a: null, b: 'y' }, testCase);

  assert.deepEqual(missing.ratios.get('tokens'), new Ratio(1, 1));
  assert.deepEqual(missing.ratios.get('types'), new Ratio(1, 1));
  assert.deepEqual(value.ratios.get('tokens'), new Ratio(0, 2));
  assert.deepEqual(value.ratios.get('types'), new Ratio(1, 2));
});

test('with nullIsMissing, AllMatched passes an expected null that the stated item does not have, as a support offer has no value; without it the null is a leaf that the stated item lacks', () => {
  const testCase = new ConfigCase().from({
    expected: { offers: [{ kind: 'support', value: null }] },
  });
  const stated = { offers: [{ kind: 'support' }] };

  const missing = new ScorerSet(
    {
      perfect: new AllMatched({ nullIsMissing: true }),
    },
    { comparer: new TreeWalk() },
  ).score(stated, testCase);
  const value = new ScorerSet(
    { perfect: new AllMatched() },
    { comparer: new TreeWalk() },
  ).score(stated, testCase);

  assert.deepEqual(
    [
      missing.passed,
      missing.reason,
      missing.checks.map((check) => check.passed),
    ],
    [true, 'each gate holds', [true]],
  );
  assert.deepEqual(
    [value.passed, value.reason],
    [false, 'perfect: $.offers[0].value: expected null, stated nothing'],
  );
});

test('with nullIsMissing, AllMatched passes a stated null where the expected key is absent, and fails a stated null where a value is expected', () => {
  const allMatched = new ScorerSet(
    {
      perfect: new AllMatched({ nullIsMissing: true }),
    },
    { comparer: new TreeWalk() },
  );
  const testCase = new ConfigCase().from({ expected: { a: 5 } });

  const extraNull = allMatched.score({ a: 5, b: null }, testCase);
  const nullForValue = allMatched.score({ a: null }, testCase);

  assert.deepEqual(
    [extraNull.passed, extraNull.reason],
    [true, 'each gate holds'],
  );
  assert.deepEqual(
    [nullForValue.passed, nullForValue.reason],
    [false, 'perfect: $.a: expected 5, stated nothing'],
  );
});
