import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CanonicalEquality,
  Gated,
  JsonCase,
  JsonTextScorer,
  JsonValue,
  LeafExactMatch,
  LeafTokenF1,
  LeafTypePrecision,
  MetricScorer,
  ParseSuccess,
  PathF1,
  PathRecall,
  RequiredKeyRecall,
  SchemaCompliance,
  ValidSchema,
} from '../index.ts';

test('JsonTextScorer reads JSON text without loss: 1.0 is a float, so it equals 1 but is not canonically equal, while the object {a: 1} is', () => {
  const scorer = new JsonTextScorer(
    new MetricScorer({
      'leaf exact match': new LeafExactMatch(),
      'canonical equality': new CanonicalEquality(),
    }),
  );
  const testCase = JsonCase.from({
    expected: { a: 1 },
    schema: { type: 'object' },
  });

  const text = scorer.score('{"a": 1.0}', testCase);
  const object = scorer.score({ a: 1 }, testCase);

  assert.equal(text.ratios.get('leaf exact match')?.value, 1);
  assert.equal(text.ratios.get('canonical equality')?.value, 0);
  assert.equal(object.ratios.get('canonical equality')?.value, 1);
});

test('JsonTextScorer keeps text that is not JSON as an unparsed value: every metric but ValidSchema gives 0', () => {
  const scorer = new JsonTextScorer(
    new MetricScorer({
      ParseSuccess: new ParseSuccess(),
      ValidSchema: new ValidSchema(),
      SchemaCompliance: new SchemaCompliance(),
      LeafExactMatch: new LeafExactMatch(),
      LeafTokenF1: new LeafTokenF1(),
      PathRecall: new PathRecall(),
      PathF1: new PathF1(),
      LeafTypePrecision: new LeafTypePrecision(),
      RequiredKeyRecall: new Gated(
        new RequiredKeyRecall({ whenNoneRequired: 1 }),
        new ParseSuccess(),
        new ValidSchema(),
      ),
      CanonicalEquality: new CanonicalEquality(),
    }),
  );
  const testCase = JsonCase.from({
    expected: { a: 'x' },
    schema: { type: 'object' },
  });

  const scorecard = scorer.score('I cannot answer.', testCase);

  assert.deepEqual(
    Object.fromEntries(
      [...scorecard.ratios].map(([name, ratio]) => [name, ratio.value]),
    ),
    {
      ParseSuccess: 0,
      ValidSchema: 1,
      SchemaCompliance: 0,
      LeafExactMatch: 0,
      LeafTokenF1: 0,
      PathRecall: 0,
      PathF1: 0,
      LeafTypePrecision: 0,
      RequiredKeyRecall: 0,
      CanonicalEquality: 0,
    },
  );
});

test('JsonValue.parse throws a SyntaxError for text that is not JSON, so a reader can skip the line', () => {
  assert.throws(() => JsonValue.parse('{"metadata": '), SyntaxError);
});

test('a JSON case needs its expected value and schema, and a weight that is a number', () => {
  assert.throws(() => JsonCase.from({ schema: {} }), /config\.expected/);
  assert.throws(() => JsonCase.from({ expected: {} }), /config\.schema/);
  assert.throws(
    () => JsonCase.from({ expected: {}, schema: {}, weight: 'heavy' }),
    /config\.weight is a number, not "heavy"/,
  );
});

test('MetricScorer passes a value only when every metric gives 1, and scores it with the mean of the metrics', () => {
  const scorer = new MetricScorer({
    'leaf exact match': new LeafExactMatch(),
    'canonical equality': new CanonicalEquality(),
  });
  const testCase = JsonCase.from({
    expected: { a: 1, b: 2 },
    schema: { type: 'object' },
  });

  const equal = scorer.score({ b: 2, a: 1 }, testCase);
  const half = scorer.score({ a: 1, b: 3 }, testCase);
  const mixed = new MetricScorer({
    'parse success': new ParseSuccess(),
    'leaf exact match': new LeafExactMatch(),
  }).score({ a: 1, b: 3 }, testCase);

  assert.equal(equal.passed, true);
  assert.equal(equal.score, 1);
  assert.equal(half.passed, false);
  assert.equal(half.score, 0.25);
  assert.equal(half.reason, 'leaf exact match 0.5, canonical equality 0');
  assert.equal(mixed.passed, false);
  assert.deepEqual(
    half.checks.map(({ name, passed, score }) => [name, passed, score]),
    [
      ['leaf exact match', false, 0.5],
      ['canonical equality', false, 0],
    ],
  );
});

test('MetricScorer reads a string as text that was not parsed, even when it looks like JSON, as evaluate.py reads a string candidate', () => {
  const scorer = new MetricScorer({ 'parse success': new ParseSuccess() });
  const testCase = JsonCase.from({
    expected: { a: 'x' },
    schema: { type: 'object' },
  });

  const scorecard = scorer.score('{"a": "x"}', testCase);

  assert.equal(scorecard.ratios.get('parse success')?.value, 0);
});

test('LeafTypePrecision gives 0 when the schema is not valid Draft 7, even where it names the type of a path', () => {
  const scorer = new MetricScorer({
    'type precision': new LeafTypePrecision(),
  });
  const invalid = JsonCase.from({
    expected: { a: 'x' },
    schema: {
      type: 'object',
      properties: { a: { type: 'string' } },
      minLength: 'not a number',
    },
  });
  const valid = JsonCase.from({
    expected: { a: 'x' },
    schema: { type: 'object', properties: { a: { type: 'string' } } },
  });

  const scorecards = [invalid, valid].map((testCase) =>
    scorer.score({ a: 'x' }, testCase),
  );

  assert.deepEqual(
    scorecards.map(
      (scorecard) => scorecard.ratios.get('type precision')?.value,
    ),
    [0, 1],
  );
});

test('RequiredKeyRecall has no gate of its own: it counts the required keys of a schema that is not valid Draft 7, and it gives whenNoneRequired for text that is not JSON; Gated with ParseSuccess and ValidSchema gives 0 for both', () => {
  const scorer = new MetricScorer({
    alone: new RequiredKeyRecall({ whenNoneRequired: 1 }),
    gated: new Gated(
      new RequiredKeyRecall({ whenNoneRequired: 1 }),
      new ParseSuccess(),
      new ValidSchema(),
    ),
  });
  const invalid = JsonCase.from({
    expected: { a: 'x' },
    schema: { type: 'object', required: ['a'], minLength: 'not a number' },
  });
  const requiresNothing = JsonCase.from({
    expected: { a: 'x' },
    schema: { type: 'object' },
  });

  const scorecards = [
    scorer.score({ a: 'x' }, invalid),
    scorer.score('I cannot answer.', requiresNothing),
  ];

  assert.deepEqual(
    scorecards.map((scorecard) => [
      scorecard.ratios.get('alone')?.value,
      scorecard.ratios.get('gated')?.value,
    ]),
    [
      [1, 0],
      [1, 0],
    ],
  );
});

test('RequiredKeyRecall gives the whenNoneRequired of its caller for a schema that requires no key', () => {
  const scorer = new MetricScorer({
    half: new RequiredKeyRecall({ whenNoneRequired: 0.5 }),
    quarter: new RequiredKeyRecall({ whenNoneRequired: 0.25 }),
  });
  const testCase = JsonCase.from({
    expected: { a: 'x' },
    schema: { type: 'object', properties: { a: { type: 'string' } } },
  });

  const scorecard = scorer.score({ a: 'x' }, testCase);

  assert.deepEqual(
    [
      scorecard.ratios.get('half')?.value,
      scorecard.ratios.get('quarter')?.value,
    ],
    [0.5, 0.25],
  );
});
