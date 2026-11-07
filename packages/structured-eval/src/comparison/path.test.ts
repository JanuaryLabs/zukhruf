import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfigCase,
  JsonSchema,
  JsonValue,
  PathMatches,
  Recall,
  RequiredKeyRecall,
  ScorerSet,
  TypePrecision,
  ValueMatches,
} from '../index.ts';

// A path is its steps, not a string (ADR 0011). SOB's evaluate.py writes a
// path as a string, so there a key that holds "." or "[" reads as a nested
// path, and an empty key adds nothing to the path. Here each key is one step.

test('a key that holds "." or "[" is one step, on each side: {"a.b": 1} is not {"a": {"b": 1}}, and {"a[0]": 1} is not {"a": [1]}', () => {
  const scorer = new ScorerSet({
    recall: new Recall(new PathMatches()),
  });
  const recall = (stated: unknown, expected: unknown) =>
    scorer
      .score(
        stated,
        new ConfigCase({
          schema: new JsonSchema(JsonValue.from({ type: 'object' }), {
            draft: '7',
          }),
        }).from({ expected: expected }),
      )
      .ratios.get('recall')?.value;

  const values = [
    recall({ a: { b: 1 } }, { 'a.b': 1 }),
    recall({ 'a.b': 1 }, { a: { b: 1 } }),
    recall({ a: [1] }, { 'a[0]': 1 }),
    recall({ 'a[0]': 1 }, { a: [1] }),
    recall({ 'a.b': 1 }, { 'a.b': 1 }),
  ];

  assert.deepEqual(values, [0, 0, 0, 0, 1]);
});

test('an empty key is a step: the leaf at {"": 1} is a leaf', () => {
  const scorer = new ScorerSet({
    match: new Recall(new ValueMatches()),
  });

  const scorecard = scorer.score(
    { '': 1 },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from({ type: 'object' }), {
        draft: '7',
      }),
    }).from({ expected: { '': 1 } }),
  );

  assert.equal(scorecard.ratios.get('match')?.value, 1);
});

test('TypePrecision reads a name that holds "." or "[" as one property of the schema', () => {
  const scorer = new ScorerSet({
    precision: new TypePrecision(),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: {
          'a.b': { type: 'string' },
          'c[0]': { type: 'string' },
        },
      }),
      { draft: '7' },
    ),
  }).from({ expected: {} });

  const values = [
    scorer.score({ 'a.b': 1, 'c[0]': 1 }, testCase).ratios.get('precision')
      ?.value,
    scorer.score({ 'a.b': 'x', 'c[0]': 'x' }, testCase).ratios.get('precision')
      ?.value,
  ];

  assert.deepEqual(values, [0, 1]);
});

test('RequiredKeyRecall compares fields by their steps: a required property named "a.b" is not met by {"a": {"b": 1}}, and a required empty key is not met by the keys under it', () => {
  const scorer = new ScorerSet({
    recall: new RequiredKeyRecall(),
  });
  const dotted = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: { 'a.b': { type: 'integer' } },
        required: ['a.b'],
      }),
      { draft: '7' },
    ),
  }).from({ expected: {} });
  const empty = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: { '': { type: 'object', required: ['b'] } },
        required: [''],
      }),
      { draft: '7' },
    ),
  }).from({ expected: {} });

  const values = [
    scorer.score({ a: { b: 1 } }, dotted).ratios.get('recall')?.value,
    scorer.score({ 'a.b': 1 }, dotted).ratios.get('recall')?.value,
    scorer.score({ b: 1 }, empty).ratios.get('recall')?.value,
    scorer.score({ '': { b: 1 } }, empty).ratios.get('recall')?.value,
  ];

  assert.deepEqual(values, [0, 1, 0, 1]);
});

test('RequiredKeyRecall reads a field without its item positions, and a key "0" is not an item', () => {
  const scorer = new ScorerSet({
    recall: new RequiredKeyRecall(),
  });
  const items = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: {
          offers: {
            type: 'array',
            items: { type: 'object', required: ['kind'] },
          },
        },
        required: ['offers'],
      }),
      { draft: '7' },
    ),
  }).from({ expected: {} });
  const zero = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: { a: { type: 'object', required: ['0'] } },
        required: ['a'],
      }),
      { draft: '7' },
    ),
  }).from({ expected: {} });

  const values = [
    scorer.score({ offers: [{}, { kind: 'x' }] }, items).ratios.get('recall')
      ?.value,
    scorer.score({ a: [1] }, zero).ratios.get('recall')?.value,
    scorer.score({ a: { '0': 1 } }, zero).ratios.get('recall')?.value,
  ];

  assert.deepEqual(values, [1, 0.5, 1]);
});
