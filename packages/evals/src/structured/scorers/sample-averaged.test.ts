import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  F1,
  PrecisionRecallForm,
  Recall,
  SampleAveraged,
  ScorerSet,
  Totals,
} from '../../index.ts';
import {
  ConfigCase,
  JsonSchema,
  JsonValue,
  PathMatches,
  TreeWalk,
  ValueMatches,
} from '../index.ts';

test('Totals gives the micro average of a plain scorer and the samples average of a SampleAveraged one: all hits over all expected values, or the mean of the values of the records', () => {
  const scorer = new ScorerSet(
    {
      micro: new Recall(new ValueMatches()),
      samples: new SampleAveraged(new Recall(new ValueMatches()), {
        whenEmpty: 0,
      }),
    },
    { comparer: new TreeWalk() },
  );
  const schema = { type: 'object' };
  const totals = new Totals();

  totals.add(
    scorer.score(
      { a: 1 },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
      }).from({ expected: { a: 1 } }),
    ),
    1,
  );
  totals.add(
    scorer.score(
      { a: 1 },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
      }).from({ expected: { a: 1, b: 2, c: 3 } }),
    ),
    1,
  );

  assert.deepEqual(
    [totals.get('micro').value, totals.get('samples').value],
    [2 / 4, (1 + 1 / 3) / 2],
  );
});

test('SampleAveraged gives the value of its scorer over 1, F1 with the bits of f1_from_counts, and the whenEmpty of its caller for a ratio with the whole 0', () => {
  const scorer = new ScorerSet(
    {
      f1: new SampleAveraged(
        new F1(new PathMatches(), { form: new PrecisionRecallForm() }),
        { whenEmpty: 0.25 },
      ),
      recall: new SampleAveraged(new Recall(new PathMatches()), {
        whenEmpty: 0.25,
      }),
      half: new SampleAveraged(new Recall(new PathMatches()), {
        whenEmpty: 0.5,
      }),
      values: new SampleAveraged(new Recall(new ValueMatches()), {
        whenEmpty: 0.75,
      }),
    },
    { comparer: new TreeWalk() },
  );
  const schema = { type: 'object' };

  const full = scorer.score(
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
    }).from({ expected: { a: 1 } }),
  );
  const empty = scorer.score(
    { a: 1 },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
    }).from({ expected: {} }),
  );

  const ratios = (scorecard: typeof full) =>
    ['f1', 'recall', 'half', 'values'].map((name) => {
      const ratio = scorecard.ratios.get(name);
      return [ratio?.part, ratio?.whole];
    });
  assert.deepEqual(ratios(full), [
    [0.33333333333333337, 1],
    [1, 1],
    [1, 1],
    [1, 1],
  ]);
  assert.deepEqual(ratios(empty), [
    [0, 1],
    [0.25, 1],
    [0.5, 1],
    [0.75, 1],
  ]);
});
