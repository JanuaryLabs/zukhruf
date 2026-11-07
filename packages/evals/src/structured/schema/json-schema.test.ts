import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Ratio } from '../../index.ts';
import {
  ConfigCase,
  JsonSchema,
  JsonValue,
  SchemaCompliance,
  ScorerSet,
  TextVarsCase,
  TypePrecision,
  ValidSchema,
} from '../index.ts';

const scorer = new ScorerSet({
  valid: new SchemaCompliance(),
  'valid schema': new ValidSchema(),
  types: new TypePrecision(),
});

test('a $schema that names a draft the package does not read throws when the schema is built, and names it; a draft that the caller sets reads that schema anyway', () => {
  const schema = JsonValue.from({
    $schema: 'https://example.com/my-draft',
    type: 'object',
  });

  assert.throws(
    () => new JsonSchema(schema),
    /https:\/\/example\.com\/my-draft is not a draft that the package reads/,
  );
  assert.equal(new JsonSchema(schema, { draft: '7' }).draft, '7');
});

test('the $schema keyword names the draft, for the validator and the types alike: draft 7 ignores the keywords beside a $ref, 2020-12 (the default) applies them', () => {
  const schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/text', type: 'number' } },
    $defs: { text: { type: 'string' } },
  };
  const read = (value: object) =>
    scorer.score(
      { a: 'x' },
      new ConfigCase({ schema: new JsonSchema(JsonValue.from(value)) }).from({
        expected: {},
      }),
    );

  const latest = read(schema);
  const draft7 = read({
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...schema,
  });

  assert.deepEqual(
    [latest.ratios.get('valid')?.part, latest.ratios.get('types')?.part],
    [0, 0],
  );
  assert.deepEqual(
    [draft7.ratios.get('valid')?.part, draft7.ratios.get('types')?.part],
    [1, 1],
  );
});

test('under 2020-12, prefixItems gives the schema of the first items and items that of the items after them, for the validator and the types alike', () => {
  const testCase = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'boolean' }],
        items: { type: 'number' },
      }),
    ),
  }).from({ expected: [] });

  const right = scorer.score(['a', true, 1, 2], testCase);
  const wrong = scorer.score([1, 'a', 'b'], testCase);

  assert.equal(right.ratios.get('valid')?.part, 1);
  assert.deepEqual(right.ratios.get('types'), new Ratio(4, 4));
  assert.equal(wrong.ratios.get('valid')?.part, 0);
  assert.deepEqual(wrong.ratios.get('types'), new Ratio(0, 3));
});

test('a schema read as draft 7 by the caller ignores prefixItems and the keywords beside a $ref, whatever its $schema says, for the validator and the types alike, also from a TextVarsCase', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      xs: {
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: { type: 'number' },
      },
      a: { $ref: '#/$defs/text', type: 'number' },
    },
    $defs: { text: { type: 'string' } },
  };
  const stated = { xs: [1, 2], a: 'x' };
  const draft7 = new TextVarsCase({
    schema: (value) => new JsonSchema(value, { draft: '7' }),
  });

  const forced = scorer.score(stated, draft7.from({ expected: '{}', schema }));
  const own = scorer.score(
    stated,
    new TextVarsCase().from({ expected: '{}', schema }),
  );

  assert.equal(forced.ratios.get('valid')?.part, 1);
  assert.deepEqual(forced.ratios.get('types'), new Ratio(3, 3));
  assert.equal(own.ratios.get('valid')?.part, 0);
  assert.deepEqual(own.ratios.get('types'), new Ratio(1, 3));
});

test('TypePrecision follows items, a $ref to $defs and anyOf to the type of a nested value, and anyOf to the items of a nested array', () => {
  const refAnyOf = scorer.score(
    { xs: ['a', 2, null] },
    new ConfigCase({
      schema: new JsonSchema(
        JsonValue.from({
          type: 'object',
          properties: { xs: { type: 'array', items: { $ref: '#/$defs/x' } } },
          $defs: { x: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        }),
      ),
    }).from({ expected: { xs: [] } }),
  );
  const nestedArray = scorer.score(
    { xs: ['a', 2] },
    new ConfigCase({
      schema: new JsonSchema(
        JsonValue.from({
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
      ),
    }).from({ expected: { xs: [] } }),
  );

  // null is a leaf, and the $defs allow it.
  assert.deepEqual(refAnyOf.ratios.get('types'), new Ratio(2, 3));
  assert.deepEqual(nestedArray.ratios.get('types'), new Ratio(1, 2));
});

// ADR 0011 decision 4: an array is a JSON value, but not a valid schema, so
// building a JsonSchema of it does not throw.
test('an array is not a valid schema: ValidSchema gives 0 of 1, and building it does not throw', () => {
  const scorecard = scorer.score(
    {},
    new ConfigCase({ schema: new JsonSchema(JsonValue.from([])) }).from({
      expected: {},
    }),
  );

  assert.deepEqual(scorecard.ratios.get('valid schema'), new Ratio(0, 1));
});

// ADR 0011 decision 4: a format is an annotation, so it no longer fails a
// record.
test('a format is an annotation: a value that breaks its format agrees with the schema, in each subschema of 2020-12 and of draft 7', () => {
  const email = { type: 'string', format: 'email' };
  const latest = {
    type: 'object',
    properties: {
      d: { type: 'string', format: 'date' },
      xs: { prefixItems: [email] },
    },
    dependentSchemas: { d: { properties: { e: email } } },
    $defs: { u: { type: 'string', format: 'uri' } },
    patternProperties: { '^u': { $ref: '#/$defs/u' } },
  };
  const draft7 = {
    type: 'object',
    properties: {
      d: { type: 'string', format: 'date' },
      xs: { items: [email] },
    },
    definitions: { u: { type: 'string', format: 'uri' } },
    patternProperties: { '^u': { $ref: '#/definitions/u' } },
  };
  const stated = { d: 'nope', e: 'nope', xs: ['nope'], u: 'nope' };

  const values = [
    new JsonSchema(JsonValue.from(latest)),
    new JsonSchema(JsonValue.from(draft7), { draft: '7' }),
  ].map(
    (schema) =>
      scorer
        .score(stated, new ConfigCase({ schema }).from({ expected: {} }))
        .ratios.get('valid')?.value,
  );

  assert.deepEqual(values, [1, 1]);
});

test('ValidSchema checks a schema against the meta-schema of its draft, down to nested schemas: a list of items is valid in draft 7 and not in 2020-12, and a bad nested type or a pattern that is not a regular expression is valid in neither', () => {
  const valid = (value: unknown, draft?: '7' | '2020-12') =>
    new JsonSchema(JsonValue.from(value), draft === undefined ? {} : { draft })
      .valid;

  assert.deepEqual(
    [valid({ items: [{}] }, '7'), valid({ items: [{}] })],
    [true, false],
  );
  assert.deepEqual(
    [
      valid({ properties: { a: { items: { type: 5 } } } }, '7'),
      valid({ properties: { a: { items: { type: 5 } } } }),
      valid({ pattern: '(' }, '7'),
      valid({ pattern: '(' }),
    ],
    [false, false, false, false],
  );
  assert.equal(
    valid({ properties: { a: { items: { type: 'string' } } } }),
    true,
  );
});
