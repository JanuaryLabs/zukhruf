import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfigCase,
  F1,
  JsonSchema,
  JsonValue,
  PathMatches,
  SampleAveraged,
  ScorerSet,
  Totals,
} from '../index.ts';

test('F1 gives one record the bits of f1_from_counts, 2·p·r/(p + r) = 0.33333333333333337 where part/whole gives 1/3, and its part 2·hits and whole stated + expected add up to the micro F1 over many records', () => {
  const scorer = new ScorerSet({ f1: new F1(new PathMatches()) });
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 1 } });
  const full = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 1, b: 2 } });

  const one = scorer.score({ a: 'other', b: 2, c: 3, d: 4, e: 5 }, testCase);
  const other = scorer.score({ a: 1, b: 2 }, full);
  const totals = new Totals();
  totals.add(one, 1);
  totals.add(other, 1);

  const ratio = one.ratios.get('f1');
  assert.equal(ratio?.value, 0.33333333333333337);
  assert.deepEqual([ratio?.part, ratio?.whole], [2, 6]);
  const pooled = totals.get('f1').ratio;
  assert.deepEqual([pooled.part, pooled.whole], [6, 10]);
  assert.equal(totals.get('f1').value, 0.6);
});

test('F1 gives 0 when only one value has paths, and a ratio with the whole 0 when neither has one, which SampleAveraged gives the whenEmpty of its caller', () => {
  const scorer = new ScorerSet({
    f1: new F1(new PathMatches()),
    quarter: new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0.25 }),
    half: new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0.5 }),
  });
  const empty = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: {} });
  const full = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 1 } });

  const scorecards = [
    scorer.score({}, empty),
    scorer.score({ a: 1 }, empty),
    scorer.score({}, full),
  ];

  assert.deepEqual(
    scorecards.map((scorecard) =>
      ['f1', 'quarter', 'half'].map((name) => {
        const ratio = scorecard.ratios.get(name);
        return [ratio?.part, ratio?.whole];
      }),
    ),
    [
      [
        [0, 0],
        [0.25, 1],
        [0.5, 1],
      ],
      [
        [0, 1],
        [0, 1],
        [0, 1],
      ],
      [
        [0, 1],
        [0, 1],
        [0, 1],
      ],
    ],
  );
});
