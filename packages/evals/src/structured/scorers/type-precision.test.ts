import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SampleAveraged } from '../../index.ts';
import {
  ConfigCase,
  JsonSchema,
  JsonValue,
  ScorerSet,
  TypePrecision,
} from '../index.ts';

// The type precision of a stated value under a schema, with no gate: the
// share of its leaves whose type the schema allows at their path, by the
// rules of JSON Schema draft 7 (ADR 0008).
const typePrecision = (schema: object, stated: unknown): number | undefined =>
  new ScorerSet({
    precision: new TypePrecision(),
  })
    .score(
      stated,
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
      }).from({ expected: {} }),
    )
    .ratios.get('precision')?.value;

test('TypePrecision grades a record that its schema refuses: the share of its leaves whose type the schema allows', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
    required: ['a', 'b'],
  };

  const value = typePrecision(schema, { a: 'x', b: 'y' });

  assert.equal(value, 0.5);
});

test('a path that the schema gives no type allows any type', () => {
  const values = [
    typePrecision({ type: 'object' }, { a: 'x', b: 1, c: null }),
    typePrecision(
      { type: 'object', properties: { a: {}, b: {}, c: {} } },
      { a: 'x', b: 1, c: null },
    ),
  ];

  assert.deepEqual(values, [1, 1]);
});

test('additionalProperties: absent allows any value, false allows none, and a schema allows its own types', () => {
  const properties = { a: { type: 'string' } };

  const values = [
    typePrecision({ type: 'object', properties }, { a: 'x', b: 1 }),
    typePrecision(
      { type: 'object', properties, additionalProperties: false },
      { a: 'x', b: 1 },
    ),
    typePrecision(
      { type: 'object', properties, additionalProperties: { type: 'integer' } },
      { a: 'x', b: 1, c: 'y' },
    ),
  ];

  assert.deepEqual(values, [1, 0.5, 2 / 3]);
});

test('patternProperties applies to the names that it matches, and a name that no pattern matches takes additionalProperties; a name that properties and a pattern both name must satisfy both; a pattern that is not a regular expression matches no name', () => {
  const schema = {
    type: 'object',
    patternProperties: { '^n_': { type: 'integer' } },
    additionalProperties: false,
  };

  const unreadable = {
    type: 'object',
    patternProperties: { '(': { type: 'integer' } },
  };

  const both = {
    type: 'object',
    properties: { n_a: { type: ['integer', 'string'] } },
    patternProperties: { '^n_': { type: 'integer' } },
  };

  const values = [
    typePrecision(schema, { n_a: 1, n_b: 'x', other: 1 }),
    typePrecision(unreadable, { a: 'x' }),
    typePrecision(both, { n_a: 'x' }),
  ];

  assert.deepEqual(values, [1 / 3, 1, 0]);
});

test('items gives the schema of each item; a list of items gives one by position, and additionalItems the items after them; prefixItems is not draft 7, so it restricts nothing', () => {
  const tuple = {
    type: 'array',
    items: [{ type: 'integer' }, { type: 'string' }],
  };

  const values = [
    typePrecision({ type: 'array', items: { type: 'integer' } }, [1, 'x']),
    typePrecision({ ...tuple, additionalItems: { type: 'boolean' } }, [
      1,
      'x',
      true,
    ]),
    typePrecision({ ...tuple, additionalItems: false }, [1, 'x', true]),
    typePrecision({ type: 'array', prefixItems: [{ type: 'string' }] }, [
      1,
      true,
    ]),
  ];

  assert.deepEqual(values, [0.5, 1, 2 / 3, 1]);
});

test('anyOf and oneOf allow the types of any branch, and allOf only the types that every member allows', () => {
  const anyOf = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  const oneOf = { oneOf: [{ type: 'string' }, { type: 'null' }] };
  const allOf = {
    allOf: [{ type: ['string', 'integer'] }, { type: 'integer' }],
  };
  const schema = {
    type: 'object',
    properties: {
      a: anyOf,
      a2: anyOf,
      b: oneOf,
      b2: oneOf,
      c: allOf,
      c2: allOf,
    },
  };

  const value = typePrecision(schema, {
    a: 1,
    a2: true,
    b: null,
    b2: 1,
    c: 2,
    c2: 'x',
  });

  assert.equal(value, 0.5);
});

test('a local $ref is followed and its sibling keywords are ignored, as draft 7 says; a $ref loop or a $ref to nothing allows no type; a pointer reads ~1 as /', () => {
  const schema = {
    definitions: {
      count: { type: 'integer' },
      loop: { $ref: '#/definitions/loop' },
      'a/b': { type: 'string' },
    },
    type: 'object',
    properties: {
      a: { $ref: '#/definitions/count' },
      b: { $ref: '#/definitions/loop' },
      c: { $ref: '#/definitions/count', type: 'string' },
      d: { $ref: '#/definitions/missing' },
      e: { $ref: '#/definitions/a~1b' },
    },
  };

  const value = typePrecision(schema, { a: 1, b: 1, c: 1, d: 1, e: 'x' });

  assert.equal(value, 3 / 5);
});

test('a $ref names the schema that the validator resolves: a URL under the $id of the schema, and the draft-07 meta-schema at its URI, whose own $refs name its own definitions', () => {
  const schema = {
    $id: 'http://example.com/offer.json',
    definitions: {
      count: { type: 'integer' },
      nonNegativeInteger: { type: 'string' },
    },
    type: 'object',
    properties: {
      a: { $ref: 'offer.json#/definitions/count' },
      b: {
        $ref: 'http://json-schema.org/draft-07/schema#/definitions/nonNegativeIntegerDefault0',
      },
      c: { $ref: '#/definitions/nonNegativeInteger' },
    },
  };

  const allowed = typePrecision(schema, { a: 1, b: 1, c: 'x' });
  const refused = typePrecision(schema, { b: 'x' });

  assert.deepEqual([allowed, refused], [1, 0]);
});

test('a property named like a member of every JavaScript object, such as constructor, has only the schema that the JSON Schema gives it', () => {
  const schema = {
    type: 'object',
    properties: { toString: { type: 'integer' } },
    additionalProperties: { type: 'string' },
  };

  const value = typePrecision(schema, { constructor: 'x', toString: 'y' });

  assert.equal(value, 1 / 2);
});

test('a path through objects and arrays reads the schema at each of its steps', () => {
  const schema = {
    type: 'object',
    properties: {
      offers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: {
              type: 'object',
              properties: {
                amount: { type: 'number' },
                currency: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  const value = typePrecision(schema, {
    offers: [{ value: { amount: 'ten', currency: 'USD' } }],
  });

  assert.equal(value, 0.5);
});

test('a leaf under a container of a type that the schema refuses has no allowed type', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'object' }, b: { type: 'array' } },
  };

  const value = typePrecision(schema, { a: [1], b: { c: 1 } });

  assert.equal(value, 0);
});

test('a list of types allows each type that it names, null included', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: ['string', 'null'] } },
  };

  const value = typePrecision(schema, { a: null });

  assert.equal(value, 1);
});

test('const and enum allow the types of their values, whatever the value', () => {
  const schema = {
    type: 'object',
    properties: { a: { const: 'x' }, b: { enum: [1, 'y'] } },
  };

  const values = [
    typePrecision(schema, { a: 'z', b: 'q' }),
    typePrecision(schema, { a: 1, b: true }),
  ];

  assert.deepEqual(values, [1, 0]);
});

test('a float with a zero fraction, such as 1.0, is an integer, as draft 7 says, though Python reads it as a float; an int is an integer, and an integer is also a number', () => {
  const schema = {
    type: 'object',
    properties: {
      n: { type: 'integer' },
      m: { type: 'integer' },
      i: { type: 'integer' },
      x: { type: 'number' },
    },
  };

  const value = typePrecision(
    schema,
    JsonValue.parse('{"n": 1.0, "m": 1.5, "i": 2, "x": 3}'),
  );

  assert.equal(value, 3 / 4);
});

test('TypePrecision counts over the stated leaves, and a stated value that has no leaf gives a ratio with the whole 0, which SampleAveraged gives the whenEmpty of its caller', () => {
  const scorer = new ScorerSet({
    precision: new TypePrecision(),
    quarter: new SampleAveraged(new TypePrecision(), { whenEmpty: 0.25 }),
    half: new SampleAveraged(new TypePrecision(), { whenEmpty: 0.5 }),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({ type: 'object', properties: { a: { type: 'string' } } }),
      { draft: '7' },
    ),
  }).from({ expected: { a: 1, b: 2, c: 3 } });

  const partial = scorer.score({ a: 1, b: 'x' }, testCase).ratios;
  const empty = scorer.score({}, testCase).ratios;

  const precision = partial.get('precision');
  assert.deepEqual([precision?.part, precision?.whole], [1, 2]);
  assert.deepEqual(
    [empty.get('quarter')?.value, empty.get('half')?.value],
    [0.25, 0.5],
  );
});
