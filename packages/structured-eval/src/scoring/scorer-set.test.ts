import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AllMatched,
  AtLeast,
  ByBestMatch,
  ComparisonSpec,
  ConfigCase,
  ExactMatch,
  F1,
  ItemMatches,
  JsonSchema,
  JsonValue,
  ParseSuccess,
  PathMatches,
  Penalized,
  PerField,
  Precision,
  Ratio,
  Recall,
  RequiredKeyRecall,
  SampleAveraged,
  SchemaCompliance,
  ScorerSet,
  TokenF1,
  TypePrecision,
  ValidSchema,
  ValueMatches,
} from '../index.ts';

// A ScorerSet of the scorers that startup-credits composes (README, "Score a
// record with a scorer set").
const offersSchema = {
  type: 'object',
  properties: {
    offers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          amount: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['kind', 'amount'],
      },
    },
  },
  required: ['offers'],
};

// ADR 0011 decision 1: an invalid record keeps its stated values in the
// denominator of precision, Ratio(0, stated), not Ratio(0, 0).
test('an invalid record gives the part 0 and keeps its wholes: valid 0 of 1, recall 0 of the expected values, precision 0 of the stated values, and the reason names the schema error', () => {
  const valid = new SchemaCompliance();
  const values = new ValueMatches();
  const scorer = new ScorerSet(
    {
      valid,
      recall: new Penalized(new Recall(values), valid),
      precision: new Penalized(new Precision(values), valid),
    },
    { spec: new ComparisonSpec({ arrays: { '$.offers': new ByBestMatch() } }) },
  );
  const cases = new ConfigCase({
    schema: new JsonSchema(JsonValue.from(offersSchema)),
  });

  const scorecard = scorer.score(
    {
      offers: [
        { kind: 'a', amount: '1' },
        { kind: 'b', amount: 2 },
      ],
    },
    cases.from({
      expected: {
        offers: [
          { kind: 'a', amount: 1 },
          { kind: 'b', amount: 2 },
        ],
      },
    }),
  );

  assert.equal(scorecard.passed, false);
  assert.deepEqual(scorecard.ratios.get('valid'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('recall'), new Ratio(0, 4));
  assert.deepEqual(scorecard.ratios.get('precision'), new Ratio(0, 4));
  assert.equal(
    scorecard.reason,
    'valid: the record does not agree with the schema: /offers/0/amount Instance type "string" is invalid. Expected "number".',
  );
});

// ADR 0011 decision 6: a text answer is unparsed, so it has no stated leaves
// and its type precision is Ratio(0, 0), not 0 of 1.
test('a text answer is unparsed: valid 0 of 1, type precision 0 of 0, and the reason says that it is not a JSON object or array', () => {
  const scorer = new ScorerSet({
    valid: new SchemaCompliance(),
    'type precision': new TypePrecision(),
  });
  const cases = new ConfigCase({
    schema: new JsonSchema(JsonValue.from(offersSchema)),
  });

  const scorecard = scorer.score(
    'I cannot list the offers.',
    cases.from({ expected: { offers: [] } }),
  );

  assert.deepEqual(scorecard.ratios.get('valid'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('type precision'), new Ratio(0, 0));
  assert.equal(
    scorecard.reason,
    'valid: the stated value is not a JSON object or array',
  );
});

test('type precision counts the wrong-typed values of an invalid record and leaves out the excluded fields, while valid reads the excluded fields too', () => {
  const scorer = new ScorerSet(
    {
      valid: new SchemaCompliance(),
      'type precision': new TypePrecision(),
    },
    { spec: new ComparisonSpec({ exclude: ['$.offers[*].note'] }) },
  );
  const cases = new ConfigCase({
    schema: new JsonSchema(JsonValue.from(offersSchema)),
  });

  const wrongTypes = scorer.score(
    {
      offers: [
        { kind: 'a', amount: '1', note: 5 },
        { kind: 'b', amount: 2 },
      ],
    },
    cases.from({ expected: { offers: [] } }),
  );
  const wrongNote = scorer.score(
    { offers: [{ kind: 'a', amount: 1, note: 5 }] },
    cases.from({ expected: { offers: [{ kind: 'a', amount: 1 }] } }),
  );

  assert.deepEqual(wrongTypes.ratios.get('valid'), new Ratio(0, 1));
  assert.deepEqual(wrongTypes.ratios.get('type precision'), new Ratio(3, 4));
  assert.deepEqual(wrongNote.ratios.get('valid'), new Ratio(0, 1));
  assert.deepEqual(wrongNote.ratios.get('type precision'), new Ratio(2, 2));
  assert.equal(wrongNote.passed, false);
});

test('a record with every field right does not pass when the schema rejects it, also when nothing is expected', () => {
  const valid = new SchemaCompliance();
  const scorer = new ScorerSet({
    valid,
    recall: new Penalized(new Recall(new ValueMatches()), valid),
  });
  const cases = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: { name: { type: 'string' }, id: { type: 'string' } },
        required: ['name', 'id'],
      }),
    ),
  });

  const scorecard = scorer.score(
    { name: 'x' },
    cases.from({ expected: { name: 'x' } }),
  );
  const nothingExpected = scorer.score({}, cases.from({ expected: {} }));

  assert.equal(scorecard.passed, false);
  assert.deepEqual(scorecard.ratios.get('recall'), new Ratio(0, 1));
  assert.equal(nothingExpected.passed, false);
});

test('a valid record whose every leaf is right and every item paired passes with every ratio 1; one more stated item, also an empty one, fails AllMatched', () => {
  const valid = new SchemaCompliance();
  const spec = new ComparisonSpec({
    arrays: { '$.offers': new ByBestMatch() },
  });
  const entries = {
    valid,
    perfect: new AllMatched(),
    recall: new Penalized(new Recall(new ValueMatches()), valid),
    precision: new Penalized(new Precision(new ValueMatches()), valid),
    'items precision': new Precision(new ItemMatches()),
  };
  const scorer = new ScorerSet(entries, { spec });
  const expected = {
    offers: [
      { kind: 'a', amount: 1 },
      { kind: 'b', amount: 2 },
    ],
  };
  const cases = new ConfigCase({
    schema: new JsonSchema(JsonValue.from(offersSchema)),
  });

  const perfect = scorer.score(expected, cases.from({ expected }));
  const extra = scorer.score(
    { offers: [...expected.offers, { kind: 'c', amount: 3 }] },
    cases.from({ expected }),
  );
  const empty = new ScorerSet(
    {
      perfect: new AllMatched(),
      'items precision': new Precision(new ItemMatches()),
    },
    { spec },
  ).score(
    { offers: [...expected.offers, {}] },
    new ConfigCase().from({ expected }),
  );

  assert.equal(perfect.passed, true);
  assert.equal(perfect.reason, 'each gate holds');
  assert.deepEqual(
    [...perfect.ratios].filter(([, ratio]) => ratio.value !== 1),
    [],
  );
  assert.equal(extra.passed, false);
  assert.deepEqual(extra.ratios.get('items precision'), new Ratio(2, 3));
  assert.equal(
    extra.reason,
    'perfect: $.offers: 2 pairs of 2 expected and 3 stated items; $.offers[2].kind: expected nothing, stated "c"; $.offers[2].amount: expected nothing, stated 3',
  );
  assert.equal(empty.passed, false);
  assert.deepEqual(empty.ratios.get('items precision'), new Ratio(2, 3));
});

// ADR 0011: the reason of a scorecard comes from the explanations of the
// gates that fail, each under its label.
test('with two set arrays, one expected item without a pair fails the record, and the reason names only that array', () => {
  const scorer = new ScorerSet(
    { perfect: new AllMatched() },
    {
      spec: new ComparisonSpec({
        arrays: { '$.tags': new ByBestMatch(), '$.notes': new ByBestMatch() },
      }),
    },
  );

  const scorecard = scorer.score(
    { tags: [{ name: 'a' }], notes: [] },
    new ConfigCase().from({ expected: { tags: [{ name: 'a' }], notes: [{}] } }),
  );

  assert.equal(scorecard.passed, false);
  assert.equal(
    scorecard.reason,
    'perfect: $.notes: 0 pairs of 1 expected and 0 stated items',
  );
});

test('a case without a schema passes when its scorers read none, and gives no schema ratio', () => {
  const scorer = new ScorerSet({
    perfect: new AllMatched(),
    recall: new Recall(new ValueMatches()),
  });

  const scorecard = scorer.score(
    { a: 1 },
    new ConfigCase().from({ expected: { a: 1 } }),
  );

  assert.equal(scorecard.passed, true);
  assert.deepEqual([...scorecard.ratios.keys()], ['perfect', 'recall']);
});

test('PerField gives a ratio for each field that its scorer counts a value in, under "<field> <label>": null and an absent key both mean no value with nullIsMissing, so a field of nulls gives no ratio', () => {
  const values = new ValueMatches({ nullIsMissing: true });
  const scorer = new ScorerSet({
    recall: new PerField(new Recall(values)),
    precision: new PerField(new Precision(values)),
  });

  const scorecard = scorer.score(
    { b: null, c: 1 },
    new ConfigCase().from({ expected: { a: null, b: 1, c: 1 } }),
  );

  assert.deepEqual(
    [...scorecard.ratios],
    [
      ['$.b recall', new Ratio(0, 1)],
      ['$.c recall', new Ratio(1, 1)],
      ['$.c precision', new Ratio(1, 1)],
    ],
  );
});

test('PerField gives no ratio for an array under a scorer of leaves, nor for a leaf under ItemMatches, and its ratios add up to the ratio of its scorer', () => {
  const scorer = new ScorerSet({
    recall: new Recall(new ValueMatches()),
    items: new Recall(new ItemMatches()),
    'recall by field': new PerField(new Recall(new ValueMatches())),
    'items by field': new PerField(new Recall(new ItemMatches())),
  });

  const scorecard = scorer.score(
    { xs: [{ k: 1 }], n: 1 },
    new ConfigCase().from({ expected: { xs: [{ k: 1 }, { k: 2 }], n: 1 } }),
  );

  assert.deepEqual(
    [...scorecard.ratios],
    [
      ['recall', new Ratio(2, 3)],
      ['items', new Ratio(1, 2)],
      ['$.xs[*].k recall by field', new Ratio(1, 2)],
      ['$.n recall by field', new Ratio(1, 1)],
      ['$.xs items by field', new Ratio(1, 2)],
    ],
  );
});

test('PerField of a wrong value at the right path: present but not right, field by field, with the field of a list item written with the wildcard selector [*]', () => {
  const scorer = new ScorerSet({
    recall: new Recall(new ValueMatches()),
    presence: new PerField(new Recall(new PathMatches())),
    'items f1': new PerField(new F1(new ItemMatches())),
  });

  const scorecard = scorer.score(
    { a: 'y', xs: [{ k: 1 }] },
    new ConfigCase().from({ expected: { a: 'x', xs: [{ k: 1 }] } }),
  );

  assert.deepEqual(scorecard.ratios.get('recall'), new Ratio(1, 2));
  assert.deepEqual(scorecard.ratios.get('$.a presence'), new Ratio(1, 1));
  assert.deepEqual(scorecard.ratios.get('$.xs[*].k presence'), new Ratio(1, 1));
  assert.deepEqual(scorecard.ratios.get('$.xs items f1')?.value, 1);
});

// ADR 0011 decision 7: one TokenF1, as SQuAD reads words, with the bits of
// 2·p·r/(p + r); a stated value that is absent is read as absentAs.
test('PerField(TokenF1) gives partial credit for shared words, compares a number as its Python text, and gives 0 for a missing value', () => {
  const scorer = new ScorerSet({
    'token f1': new TokenF1({ whenNoWords: 1, absentAs: null }),
    'by field': new PerField(new TokenF1({ whenNoWords: 1, absentAs: null })),
  });

  const scorecard = scorer.score(
    { t: 'AWS credits', n: 1000 },
    new ConfigCase().from({
      expected: { t: 'AWS credits for startups', n: 1000, m: 'gone' },
    }),
  );

  const words = (2 * 1 * 0.5) / (1 + 0.5);
  assert.deepEqual(scorecard.ratios.get('$.t by field'), new Ratio(words, 1));
  assert.deepEqual(scorecard.ratios.get('$.n by field'), new Ratio(1, 1));
  assert.deepEqual(scorecard.ratios.get('$.m by field'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('token f1'), new Ratio(words + 1, 3));
});

test('a gate inside PerField reads the whole record: an invalid record gives each field the part 0 and keeps its whole', () => {
  const valid = new SchemaCompliance();
  const scorer = new ScorerSet({
    recall: new PerField(new Penalized(new Recall(new ValueMatches()), valid)),
  });
  const cases = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object', required: ['z'] })),
  });

  const scorecard = scorer.score(
    { a: 1, b: 2 },
    cases.from({ expected: { a: 1, b: 2 } }),
  );
  const compliant = scorer.score(
    { a: 1, b: 2, z: 0 },
    cases.from({ expected: { a: 1, b: 2 } }),
  );

  assert.deepEqual(scorecard.ratios.get('$.a recall'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('$.b recall'), new Ratio(0, 1));
  assert.deepEqual(compliant.ratios.get('$.a recall'), new Ratio(1, 1));
  assert.deepEqual(compliant.ratios.get('$.b recall'), new Ratio(1, 1));
});

test('the reason names each schema error once, and at most 5 of them with a count of the rest', () => {
  const scorer = new ScorerSet({ valid: new SchemaCompliance() });
  const sevenNumbers = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: Object.fromEntries(
          ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => [
            key,
            { type: 'number' },
          ]),
        ),
      }),
    ),
  });
  const twoSameBranches = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        anyOf: [
          { properties: { a: { type: 'number' } } },
          { properties: { a: { type: 'number' } } },
        ],
      }),
    ),
  });
  const stated = { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x', f: 'x', g: 'x' };

  const seven = scorer.score(stated, sevenNumbers.from({ expected: {} }));
  const repeated = scorer.score(
    { a: 'x' },
    twoSameBranches.from({ expected: {} }),
  );

  const error = (key: string) =>
    `/${key} Instance type "string" is invalid. Expected "number".`;
  assert.equal(
    seven.reason,
    `valid: the record does not agree with the schema: ${['a', 'b', 'c', 'd', 'e'].map(error).join(', ')} and 2 more`,
  );
  assert.equal(
    repeated.reason,
    `valid: the record does not agree with the schema: ${error('a')}`,
  );
});

test('each gate explains why a record fails it, the checks are the gates, and the score is the mean of the values of the scorers, PerField aside', () => {
  const scorer = new ScorerSet({
    parsed: new ParseSuccess(),
    'valid schema': new ValidSchema(),
    exact: new ExactMatch(),
    covered: new AtLeast(new Recall(new ValueMatches()), 0.75),
    perfect: new AllMatched(),
    recall: new Recall(new ValueMatches()),
    'by field': new PerField(new Recall(new ValueMatches())),
  });
  const cases = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({ type: 'object', minProperties: -1 }),
    ),
  });

  const scorecard = scorer.score(
    { a: 1, b: 'y', c: null },
    cases.from({ expected: { a: 1.0, b: 'x' } }),
  );

  assert.equal(scorecard.passed, false);
  assert.deepEqual(
    scorecard.checks.map(({ name, passed }) => [name, passed]),
    [
      ['parsed', true],
      ['valid schema', false],
      ['exact', false],
      ['covered', false],
      ['perfect', false],
    ],
  );
  assert.equal(
    scorecard.reason,
    [
      'valid schema: the JSON Schema of the case is not a valid schema of draft 2020-12',
      'exact: the canonical JSON of the stated value is not that of the expected value',
      'covered: the value 0.5 is below the threshold 0.75',
      'perfect: $.b: expected "x", stated "y"; $.c: expected nothing, stated null',
    ].join('; '),
  );
  assert.equal(scorecard.score, (1 + 0 + 0 + 0 + 0 + 0.5) / 6);
});

test('ScorerSet reads a stated JSON text as json.loads does, without loss: 1.0 is a float, so it equals 1 but is not canonically equal, while the object {a: 1} is', () => {
  const scorer = new ScorerSet({
    'leaf exact match': new Recall(new ValueMatches()),
    'canonical equality': new ExactMatch(),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 1 } });

  const text = scorer.score('{"a": 1.0}', testCase);
  const object = scorer.score({ a: 1 }, testCase);

  assert.equal(text.ratios.get('leaf exact match')?.value, 1);
  assert.equal(text.ratios.get('canonical equality')?.value, 0);
  assert.equal(object.ratios.get('canonical equality')?.value, 1);
});

test('ScorerSet keeps a stated text that is not JSON as an unparsed value: every scorer but ValidSchema gives 0', () => {
  const scorer = new ScorerSet({
    ParseSuccess: new ParseSuccess(),
    ValidSchema: new ValidSchema(),
    SchemaCompliance: new SchemaCompliance(),
    ValueRecall: new Recall(new ValueMatches()),
    TokenF1: new TokenF1({ whenNoWords: 1, absentAs: null }),
    PathMatchesRecall: new Recall(new PathMatches()),
    PathMatchesF1: new F1(new PathMatches()),
    TypePrecision: new TypePrecision(),
    RequiredKeyRecall: new Penalized(
      new SampleAveraged(new RequiredKeyRecall(), { whenEmpty: 1 }),
      new ParseSuccess(),
      new ValidSchema(),
    ),
    ExactMatch: new ExactMatch(),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 'x' } });

  const scorecard = scorer.score('I cannot answer.', testCase);

  assert.deepEqual(
    Object.fromEntries(
      [...scorecard.ratios].map(([name, ratio]) => [name, ratio.value]),
    ),
    {
      ParseSuccess: 0,
      ValidSchema: 1,
      SchemaCompliance: 0,
      ValueRecall: 0,
      TokenF1: 0,
      PathMatchesRecall: 0,
      PathMatchesF1: 0,
      TypePrecision: 0,
      RequiredKeyRecall: 0,
      ExactMatch: 0,
    },
  );
});

// ADR 0011: a ScorerSet passes when each of its gates holds, not when every
// value is 1; its reason is the explanations of the gates that fail, and its
// checks are its gates.
test('ScorerSet passes a value when each of its gates holds, whatever the other values, and scores it with the mean of the scorers', () => {
  const scorer = new ScorerSet({
    'leaf exact match': new Recall(new ValueMatches()),
    'canonical equality': new ExactMatch(),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 1, b: 2 } });

  const equal = scorer.score({ b: 2, a: 1 }, testCase);
  const half = scorer.score({ a: 1, b: 3 }, testCase);
  const mixed = new ScorerSet({
    'parse success': new ParseSuccess(),
    'leaf exact match': new Recall(new ValueMatches()),
  }).score({ a: 1, b: 3 }, testCase);

  assert.equal(equal.passed, true);
  assert.equal(equal.score, 1);
  assert.equal(half.passed, false);
  assert.equal(half.score, 0.25);
  assert.equal(
    half.reason,
    'canonical equality: the canonical JSON of the stated value is not that of the expected value',
  );
  assert.equal(mixed.passed, true);
  assert.equal(mixed.score, 0.75);
  assert.deepEqual(
    half.checks.map(({ name, passed, score }) => [name, passed, score]),
    [['canonical equality', false, 0]],
  );
});

test('ScorerSet reads a stated JsonValue as it is: a string candidate that looks like JSON is not parsed again, as evaluate.py reads a string candidate', () => {
  const scorer = new ScorerSet({ 'parse success': new ParseSuccess() });
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 'x' } });

  const candidate = scorer.score(
    JsonValue.parse('"{\\"a\\": \\"x\\"}"'),
    testCase,
  );
  const text = scorer.score('{"a": "x"}', testCase);

  assert.equal(candidate.ratios.get('parse success')?.value, 0);
  assert.equal(text.ratios.get('parse success')?.value, 1);
});

test('TypePrecision has no gate of its own: it reads the types that a schema that is not valid Draft 7 names, and Penalized with ValidSchema gives 0', () => {
  const scorer = new ScorerSet({
    alone: new TypePrecision(),
    gated: new Penalized(new TypePrecision(), new ValidSchema()),
  });
  const invalid = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: { a: { type: 'string' } },
        minLength: 'not a number',
      }),
      { draft: '7' },
    ),
  }).from({ expected: { a: 'x' } });
  const valid = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({ type: 'object', properties: { a: { type: 'string' } } }),
      { draft: '7' },
    ),
  }).from({ expected: { a: 'x' } });

  const scorecards = [invalid, valid].map((testCase) =>
    scorer.score({ a: 'x' }, testCase),
  );

  assert.deepEqual(
    scorecards.map((scorecard) => [
      scorecard.ratios.get('alone')?.value,
      scorecard.ratios.get('gated')?.value,
    ]),
    [
      [1, 0],
      [1, 1],
    ],
  );
});

test('RequiredKeyRecall has no gate of its own: it counts the required keys of a schema that is not valid Draft 7, and SampleAveraged gives its whenEmpty for text that is not JSON under a schema that requires none; Penalized with ParseSuccess and ValidSchema gives 0 for both', () => {
  const scorer = new ScorerSet({
    alone: new SampleAveraged(new RequiredKeyRecall(), { whenEmpty: 1 }),
    gated: new Penalized(
      new SampleAveraged(new RequiredKeyRecall(), { whenEmpty: 1 }),
      new ParseSuccess(),
      new ValidSchema(),
    ),
  });
  const invalid = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        required: ['a'],
        minLength: 'not a number',
      }),
      { draft: '7' },
    ),
  }).from({ expected: { a: 'x' } });
  const requiresNothing = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 'x' } });

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

test('RequiredKeyRecall gives a ratio with the whole 0 for a schema that requires no key, which SampleAveraged gives the whenEmpty of its caller', () => {
  const scorer = new ScorerSet({
    alone: new RequiredKeyRecall(),
    half: new SampleAveraged(new RequiredKeyRecall(), { whenEmpty: 0.5 }),
    quarter: new SampleAveraged(new RequiredKeyRecall(), { whenEmpty: 0.25 }),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({ type: 'object', properties: { a: { type: 'string' } } }),
      { draft: '7' },
    ),
  }).from({ expected: { a: 'x' } });

  const scorecard = scorer.score({ a: 'x' }, testCase);

  assert.equal(scorecard.ratios.get('alone')?.whole, 0);
  assert.deepEqual(
    [
      scorecard.ratios.get('half')?.value,
      scorecard.ratios.get('quarter')?.value,
    ],
    [0.5, 0.25],
  );
});
