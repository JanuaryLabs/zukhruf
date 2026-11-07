import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AtLeast,
  type Comparison,
  ConfigCase,
  F1,
  JsonSchema,
  JsonValue,
  ParseSuccess,
  PathMatches,
  Penalized,
  Penalty,
  Recall,
  SampleAveraged,
  SchemaCompliance,
  ScorerSet,
  ShortfallPenalty,
  ValidSchema,
  ValueMatches,
} from '../index.ts';

test('Penalized gives the part 0 for a record that fails any of its gates, and keeps the whole, so an invalid record keeps its expected values in the denominator of recall', () => {
  const recall = new Recall(new ValueMatches());
  const scorer = new ScorerSet({
    first: new Penalized(recall, new SchemaCompliance(), new ParseSuccess()),
    last: new Penalized(recall, new ParseSuccess(), new SchemaCompliance()),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({ type: 'object', required: ['z'] }),
      { draft: '7' },
    ),
  }).from({ expected: { a: 1, b: 2, c: 3 } });

  const scorecard = scorer.score({ a: 1, b: 2 }, testCase);

  assert.deepEqual(
    ['first', 'last'].map((name) => {
      const ratio = scorecard.ratios.get(name);
      return [ratio?.part, ratio?.whole];
    }),
    [
      [0, 3],
      [0, 3],
    ],
  );
});

test('each gate can fail a record: ParseSuccess for text that is not parsed, ValidSchema for a schema that is not valid', () => {
  const whenEmpty = new SampleAveraged(new Recall(new ValueMatches()), {
    whenEmpty: 1,
  });
  const scorer = new ScorerSet({
    alone: whenEmpty,
    parsed: new Penalized(whenEmpty, new ParseSuccess()),
    schema: new Penalized(whenEmpty, new ValidSchema()),
  });
  const valid = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: {} });
  const invalid = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({ type: 'object', minLength: 'not a number' }),
      { draft: '7' },
    ),
  }).from({ expected: {} });

  const scorecards = [
    scorer.score('not parsed', valid),
    scorer.score({}, invalid),
  ];

  assert.deepEqual(
    scorecards.map((scorecard) =>
      ['alone', 'parsed', 'schema'].map((name) => {
        const ratio = scorecard.ratios.get(name);
        return [ratio?.part, ratio?.whole];
      }),
    ),
    [
      [
        [1, 1],
        [0, 1],
        [1, 1],
      ],
      [
        [1, 1],
        [1, 1],
        [0, 1],
      ],
    ],
  );
});

test('Penalized gives the ratio of its scorer as it is when every gate holds, so an F1 keeps the bits of f1_from_counts', () => {
  const scorer = new ScorerSet({
    f1: new Penalized(
      new F1(new PathMatches()),
      new ParseSuccess(),
      new SchemaCompliance(),
    ),
  });

  const scorecard = scorer.score(
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from({ type: 'object' }), {
        draft: '7',
      }),
    }).from({ expected: { a: 1 } }),
  );

  const ratio = scorecard.ratios.get('f1');
  assert.deepEqual(
    [ratio?.value, ratio?.part, ratio?.whole],
    [0.33333333333333337, 2, 6],
  );
});

test('a gate gives 1 of 1 or 0 of 1, and AtLeast holds when the value of its scorer reaches the threshold, the value of an F1 and not its part over its whole', () => {
  const f1 = new F1(new PathMatches());
  const scorer = new ScorerSet({
    parsed: new ParseSuccess(),
    reached: new AtLeast(f1, 0.33333333333333337),
    above: new AtLeast(f1, 0.3333333333333334),
  });

  const scorecard = scorer.score(
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from({ type: 'object' }), {
        draft: '7',
      }),
    }).from({ expected: { a: 1 } }),
  );

  assert.deepEqual(
    ['parsed', 'reached', 'above'].map((name) => {
      const ratio = scorecard.ratios.get(name);
      return [ratio?.part, ratio?.whole];
    }),
    [
      [1, 1],
      [1, 1],
      [0, 1],
    ],
  );
});

// A penalty whose factor the test gives, for the factors that no penalty of
// the package gives.
class FixedPenalty extends Penalty {
  readonly #factor: number;

  constructor(factor: number) {
    super();
    this.#factor = factor;
  }

  factor(_comparison: Comparison): number {
    return this.#factor;
  }
}

test('Penalized throws a RangeError for a factor above 1, below 0 or NaN, so a penalty cannot raise a part above its whole or below 0', () => {
  const recall = new Recall(new ValueMatches());
  const testCase = new ConfigCase().from({ expected: { a: 1 } });

  const scores = [1.5, -0.25, Number.NaN].map(
    (factor) => () =>
      new ScorerSet({
        penalized: new Penalized(
          recall,
          new FixedPenalty(1),
          new FixedPenalty(factor),
        ),
      }).score({ a: 1 }, testCase),
  );

  for (const score of scores) assert.throws(score, RangeError);
});

test('Penalized multiplies the part by each factor in the order of its arguments and keeps the whole, as evaluate.py multiplies raw × hardening × coverage_gate', () => {
  // Path F1 4 hits of 7 stated and 6 expected: 0.6153846153846153. Its
  // factors are 0.46752867265687764 for the target 0.9 and
  // 0.7728535201062673 for 0.7, and the recall of the values is 2 of 6.
  const keys = new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0 });
  const near = new ShortfallPenalty(keys, { target: 0.9, power: 2 });
  const far = new ShortfallPenalty(keys, { target: 0.7, power: 2 });
  const values = new SampleAveraged(new Recall(new ValueMatches()), {
    whenEmpty: 1,
  });
  const micro = new Recall(new ValueMatches());
  const scorer = new ScorerSet({
    nearFirst: new Penalized(values, near, far),
    farFirst: new Penalized(values, far, near),
    micro: new Penalized(micro, near),
  });
  const testCase = new ConfigCase().from({
    expected: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
  });

  const scorecard = scorer.score(
    { a: 1, b: 2, c: 0, d: 0, g: 7, h: 8, i: 9 },
    testCase,
  );

  assert.deepEqual(
    ['nearFirst', 'farFirst', 'micro'].map((name) => {
      const ratio = scorecard.ratios.get(name);
      return [ratio?.part, ratio?.whole];
    }),
    [
      // (1/3 × 0.46752867265687764) × 0.7728535201062673; the product of the
      // factors first gives 0.12044372680449289.
      [0.12044372680449286, 1],
      [0.12044372680449288, 1],
      [2 * 0.46752867265687764, 6],
    ],
  );
});
