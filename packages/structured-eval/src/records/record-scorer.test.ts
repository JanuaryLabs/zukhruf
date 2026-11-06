import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ByBestMatch,
  ByPosition,
  NormalizedText,
  NumberWithin,
  Ratio,
  RecordCase,
  RecordSchema,
  RecordScorer,
  RecordSpec,
  TokenOverlapAtLeast,
} from '../index.ts';

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

test('an invalid record counts as a record that stated nothing: valid 0 with weight 1, its expected values stay in the recall, and the reason names the schema error', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema(offersSchema),
      arrays: { offers: new ByBestMatch() },
    }),
  );
  const expected = {
    offers: [
      { kind: 'a', amount: 1 },
      { kind: 'b', amount: 2 },
    ],
  };

  const scorecard = scorer.score(
    {
      offers: [
        { kind: 'a', amount: '1' },
        { kind: 'b', amount: 2 },
      ],
    },
    new RecordCase(expected),
  );

  assert.equal(scorecard.passed, false);
  assert.deepEqual(scorecard.ratios.get('valid'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('recall'), new Ratio(0, 4));
  assert.deepEqual(scorecard.ratios.get('precision'), new Ratio(0, 0));
  assert.match(
    scorecard.reason,
    /does not agree with the schema: \/offers\/0\/amount/,
  );
});

test('a text answer scores valid 0 and type safety 0 of 1', () => {
  const scorer = new RecordScorer(
    new RecordSpec({ schema: new RecordSchema(offersSchema) }),
  );

  const scorecard = scorer.score(
    'I cannot list the offers.',
    new RecordCase({ offers: [] }),
  );

  assert.deepEqual(scorecard.ratios.get('valid'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('type safety'), new Ratio(0, 1));
});

test('type safety counts the wrong-typed values of an invalid record, and leaves out the ignored fields', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema(offersSchema),
      ignore: ['offers[].note'],
    }),
  );

  const scorecard = scorer.score(
    {
      offers: [
        { kind: 'a', amount: '1', note: 5 },
        { kind: 'b', amount: 2 },
      ],
    },
    new RecordCase({ offers: [] }),
  );

  assert.deepEqual(scorecard.ratios.get('valid'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('type safety'), new Ratio(3, 4));
});

test('valid reads the ignored fields too', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema(offersSchema),
      ignore: ['offers[].note'],
    }),
  );

  const scorecard = scorer.score(
    { offers: [{ kind: 'a', amount: 1, note: 5 }] },
    new RecordCase({ offers: [{ kind: 'a', amount: 1 }] }),
  );

  assert.deepEqual(scorecard.ratios.get('valid'), new Ratio(0, 1));
  assert.equal(scorecard.passed, false);
});

test('a record with every field right does not pass when the schema rejects it', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema({
        type: 'object',
        properties: { name: { type: 'string' }, id: { type: 'string' } },
        required: ['name', 'id'],
      }),
    }),
  );

  const scorecard = scorer.score({ name: 'x' }, new RecordCase({ name: 'x' }));
  const nothingExpected = scorer.score({}, new RecordCase({}));

  assert.equal(scorecard.passed, false);
  assert.deepEqual(scorecard.ratios.get('recall'), new Ratio(0, 1));
  assert.equal(nothingExpected.passed, false);
});

test('a valid record whose every field is right and every item paired passes with every ratio 1; one more stated item makes it fail', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema(offersSchema),
      arrays: { offers: new ByBestMatch() },
    }),
  );
  const expected = {
    offers: [
      { kind: 'a', amount: 1 },
      { kind: 'b', amount: 2 },
    ],
  };

  const perfect = scorer.score(expected, new RecordCase(expected));
  const extra = scorer.score(
    { offers: [...expected.offers, { kind: 'c', amount: 3 }] },
    new RecordCase(expected),
  );

  assert.equal(perfect.passed, true);
  assert.deepEqual(
    [...perfect.ratios].filter(([, ratio]) => ratio.value !== 1),
    [],
  );
  assert.ok(perfect.ratios.has('valid'));
  const empty = new RecordScorer(
    new RecordSpec({ arrays: { offers: new ByBestMatch() } }),
  ).score({ offers: [...expected.offers, {}] }, new RecordCase(expected));
  assert.equal(extra.passed, false);
  assert.deepEqual(extra.ratios.get('offers items precision'), new Ratio(2, 3));
  assert.equal(empty.passed, false);
  assert.deepEqual(empty.ratios.get('offers items precision'), new Ratio(2, 3));
});

test('with two set arrays, one expected item without a pair fails the record, and the reason names only that array', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      arrays: { tags: new ByBestMatch(), notes: new ByBestMatch() },
    }),
  );

  const scorecard = scorer.score(
    { tags: [{ name: 'a' }], notes: [] },
    new RecordCase({ tags: [{ name: 'a' }], notes: [{}] }),
  );

  assert.equal(scorecard.passed, false);
  assert.equal(
    scorecard.reason,
    'notes: 0 pairs of 1 expected and 0 stated items',
  );
});

test('a spec without a schema gives no valid or type safety ratio, and its record can pass', () => {
  const scorer = new RecordScorer(new RecordSpec());

  const scorecard = scorer.score({ a: 1 }, new RecordCase({ a: 1 }));

  assert.equal(scorecard.passed, true);
  assert.equal(scorecard.ratios.has('valid'), false);
  assert.equal(scorecard.ratios.has('type safety'), false);
});

test('a set array pairs a reordered list item by item, so every ratio is 1', () => {
  const scorer = new RecordScorer(
    new RecordSpec({ arrays: { offers: new ByBestMatch() } }),
  );
  const expected = {
    offers: [
      { kind: 'a', amount: 1 },
      { kind: 'b', amount: 2 },
      { kind: 'c', amount: 3 },
    ],
  };

  const scorecard = scorer.score(
    { offers: [...expected.offers].reverse() },
    new RecordCase(expected),
  );

  assert.equal(scorecard.passed, true);
  assert.deepEqual(
    [...scorecard.ratios].filter(([, ratio]) => ratio.value !== 1),
    [],
  );
});

test('a set array takes the pairing with the most agreeing fields, where pairing each stated item with its best match first would leave one unpaired', () => {
  const scorer = new RecordScorer(
    new RecordSpec({ arrays: { xs: new ByBestMatch() } }),
  );
  const expected = {
    xs: [
      { f1: 1, f2: 1, f3: 1, f4: 0, f5: 0 },
      { f1: 0, f2: 0, f3: 0, f4: 2, f5: 2 },
    ],
  };

  const scorecard = scorer.score(
    {
      xs: [
        { f1: 1, f2: 1, f3: 1, f4: 2, f5: 2 },
        { f1: 1, f2: 1, f3: 9, f4: 9, f5: 9 },
      ],
    },
    new RecordCase(expected),
  );

  assert.deepEqual(scorecard.ratios.get('xs items recall'), new Ratio(2, 2));
  assert.deepEqual(scorecard.ratios.get('recall'), new Ratio(4, 10));
});

test('a match that forbids a pair leaves both items unpaired, even when their fields agree', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      arrays: {
        xs: new ByBestMatch({
          canPair: (stated, expected) =>
            JSON.stringify(stated).includes('"id":1') &&
            JSON.stringify(expected).includes('"id":1'),
        }),
      },
    }),
  );

  const scorecard = scorer.score(
    { xs: [{ id: 2, v: 'a' }] },
    new RecordCase({ xs: [{ id: 1, v: 'a' }] }),
  );

  assert.deepEqual(scorecard.ratios.get('xs items recall'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('xs items precision'), new Ratio(0, 1));
});

test('without a match, items that agree on nothing stay unpaired', () => {
  const scorer = new RecordScorer(
    new RecordSpec({ arrays: { xs: new ByBestMatch() } }),
  );

  const scorecard = scorer.score(
    { xs: [{ v: 'b' }] },
    new RecordCase({ xs: [{ v: 'a' }] }),
  );

  assert.deepEqual(scorecard.ratios.get('xs items recall'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('xs items precision'), new Ratio(0, 1));
});

test('an array that the spec does not name pairs by position, as ByPosition does', () => {
  const unnamed = new RecordScorer(new RecordSpec());
  const named = new RecordScorer(
    new RecordSpec({ arrays: { xs: new ByPosition() } }),
  );
  const testCase = new RecordCase({ xs: ['a', 'b'] });

  const scorecards = [unnamed, named].map((scorer) =>
    scorer.score({ xs: ['b', 'a'] }, testCase),
  );

  for (const scorecard of scorecards)
    assert.deepEqual(scorecard.ratios.get('xs[] recall'), new Ratio(0, 2));
});

test('null and an absent key both mean no value', () => {
  const scorer = new RecordScorer(new RecordSpec());

  const scorecard = scorer.score(
    { b: null },
    new RecordCase({ a: null, b: 1 }),
  );

  assert.equal(scorecard.ratios.has('a recall'), false);
  assert.deepEqual(scorecard.ratios.get('b recall'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('b precision'), new Ratio(0, 0));
});

test('NumberWithin agrees inside its tolerance and not outside it', () => {
  const scorer = new RecordScorer(
    new RecordSpec({ fields: { n: new NumberWithin(0.5) } }),
  );

  const inside = scorer.score({ n: 10.4 }, new RecordCase({ n: 10 }));
  const edge = scorer.score({ n: 10.5 }, new RecordCase({ n: 10 }));
  const outside = scorer.score({ n: 10.6 }, new RecordCase({ n: 10 }));

  assert.deepEqual(inside.ratios.get('n recall'), new Ratio(1, 1));
  assert.deepEqual(edge.ratios.get('n recall'), new Ratio(1, 1));
  assert.deepEqual(outside.ratios.get('n recall'), new Ratio(0, 1));
});

test('NormalizedText agrees across case, spaces and Unicode width, not across a different letter', () => {
  const scorer = new RecordScorer(
    new RecordSpec({ fields: { t: new NormalizedText() } }),
  );
  const testCase = new RecordCase({ t: 'café credits' });

  const same = scorer.score({ t: '  ＣＡＦÉ   Credits ' }, testCase);
  const other = scorer.score({ t: 'cafe credits' }, testCase);

  assert.deepEqual(same.ratios.get('t recall'), new Ratio(1, 1));
  assert.deepEqual(other.ratios.get('t recall'), new Ratio(0, 1));
});

test('TokenOverlapAtLeast agrees when the word F1 reaches its threshold', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      fields: { t: new TokenOverlapAtLeast((2 * 2) / (2 + 4)) },
    }),
  );
  const testCase = new RecordCase({ t: 'AWS credits for startups' });

  const enough = scorer.score({ t: 'AWS credits' }, testCase);
  const short = scorer.score({ t: 'AWS' }, testCase);

  assert.deepEqual(enough.ratios.get('t recall'), new Ratio(1, 1));
  assert.deepEqual(short.ratios.get('t recall'), new Ratio(0, 1));
});

test('a field that the spec does not name agrees only on the same value', () => {
  const scorer = new RecordScorer(new RecordSpec());

  const right = scorer.score({ n: 1 }, new RecordCase({ n: 1 }));
  const wrong = scorer.score({ n: 2 }, new RecordCase({ n: 1 }));
  const text = scorer.score({ n: '1' }, new RecordCase({ n: 1 }));

  assert.deepEqual(right.ratios.get('n recall'), new Ratio(1, 1));
  assert.deepEqual(wrong.ratios.get('n recall'), new Ratio(0, 1));
  assert.deepEqual(text.ratios.get('n recall'), new Ratio(0, 1));
});

test('an ignored field and its children are out of every ratio', () => {
  const scorer = new RecordScorer(new RecordSpec({ ignore: ['notes'] }));

  const scorecard = scorer.score(
    { a: 1, notes: { x: 'other' } },
    new RecordCase({ a: 1, notes: { x: 'long text' } }),
  );

  assert.equal(scorecard.passed, true);
  assert.deepEqual(
    [...scorecard.ratios.keys()].filter((name) => name.includes('notes')),
    [],
  );
});

test('a wrong value at the right path is present but not right', () => {
  const scorer = new RecordScorer(new RecordSpec());

  const scorecard = scorer.score({ a: 'y' }, new RecordCase({ a: 'x' }));

  assert.deepEqual(scorecard.ratios.get('recall'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('presence recall'), new Ratio(1, 1));
  assert.deepEqual(scorecard.ratios.get('presence precision'), new Ratio(1, 1));
  assert.deepEqual(scorecard.ratios.get('presence f1'), new Ratio(2, 2));
  assert.deepEqual(scorecard.ratios.get('a presence recall'), new Ratio(1, 1));
});

test('token f1 gives partial credit for shared words, 0 for a missing value, and compares a number as its JSON text', () => {
  const scorer = new RecordScorer(new RecordSpec());

  const scorecard = scorer.score(
    { t: 'AWS credits', n: 1000 },
    new RecordCase({ t: 'AWS credits for startups', n: 1000, m: 'gone' }),
  );

  const words = (2 * 2) / (2 + 4);
  assert.deepEqual(scorecard.ratios.get('t token f1'), new Ratio(words, 1));
  assert.deepEqual(scorecard.ratios.get('n token f1'), new Ratio(1, 1));
  assert.deepEqual(scorecard.ratios.get('m token f1'), new Ratio(0, 1));
  assert.deepEqual(scorecard.ratios.get('token f1'), new Ratio(words + 1, 3));
});

test('the $schema keyword names the draft: draft 7 ignores the keywords beside a $ref, 2020-12 (the default) applies them', () => {
  const schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/text', type: 'number' } },
    $defs: { text: { type: 'string' } },
  };
  const latest = new RecordScorer(
    new RecordSpec({ schema: new RecordSchema(schema) }),
  );
  const draft7 = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        ...schema,
      }),
    }),
  );
  const testCase = new RecordCase({ a: 'x' });

  assert.deepEqual(
    latest.score({ a: 'x' }, testCase).ratios.get('valid'),
    new Ratio(0, 1),
  );
  assert.deepEqual(
    draft7.score({ a: 'x' }, testCase).ratios.get('valid'),
    new Ratio(1, 1),
  );
  assert.throws(
    () => new RecordSchema({ $schema: 'https://example.com/my-draft' }),
    /https:\/\/example\.com\/my-draft is not a draft/,
  );
});

test('type safety follows items, $ref and anyOf to the type of a nested value', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema({
        type: 'object',
        properties: {
          xs: { type: 'array', items: { $ref: '#/$defs/x' } },
        },
        $defs: { x: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      }),
    }),
  );

  const scorecard = scorer.score(
    { xs: ['a', 2, null] },
    new RecordCase({ xs: [] }),
  );

  assert.deepEqual(scorecard.ratios.get('type safety'), new Ratio(1, 2));
});

test('the reason names each schema error once, and at most 5 of them with a count of the rest', () => {
  const sevenNumbers = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema({
        type: 'object',
        properties: Object.fromEntries(
          ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => [
            key,
            { type: 'number' },
          ]),
        ),
      }),
    }),
  );
  const twoSameBranches = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema({
        anyOf: [
          { properties: { a: { type: 'number' } } },
          { properties: { a: { type: 'number' } } },
        ],
      }),
    }),
  );
  const stated = { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x', f: 'x', g: 'x' };

  const seven = sevenNumbers.score(stated, new RecordCase({}));
  const repeated = twoSameBranches.score({ a: 'x' }, new RecordCase({}));

  const error = (key: string) =>
    `/${key} Instance type "string" is invalid. Expected "number".`;
  assert.equal(
    seven.reason,
    `the record does not agree with the schema: ${['a', 'b', 'c', 'd', 'e'].map(error).join(', ')} and 2 more`,
  );
  assert.equal(
    repeated.reason.split(';')[0],
    `the record does not agree with the schema: ${error('a')}`,
  );
});

test('a JSON Schema is an object, not an array', () => {
  assert.throws(() => new RecordSchema([]), /A JSON Schema is an object/);
});

test('type safety follows anyOf to the items of a nested array', () => {
  const scorer = new RecordScorer(
    new RecordSpec({
      schema: new RecordSchema({
        type: 'object',
        properties: {
          xs: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
          },
        },
      }),
    }),
  );

  const scorecard = scorer.score({ xs: ['a', 2] }, new RecordCase({ xs: [] }));

  assert.deepEqual(scorecard.ratios.get('type safety'), new Ratio(1, 2));
});
