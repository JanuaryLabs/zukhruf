import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ExactMatch,
  F1,
  PathMatches,
  SchemaCompliance,
  ScorerAssertion,
} from '../index.ts';

test('weight and threshold are both required: a rule without one of them does not type-check', () => {
  type Rule = Pick<
    ConstructorParameters<typeof ScorerAssertion>[1],
    'weight' | 'threshold'
  >;
  const bothRequired: [Rule] extends [Required<Rule>] ? true : false = true;

  assert.equal(bothRequired, true);
});

test('an answer text that is not JSON scores 0 and does not fail the test: prose, cut-off JSON and empty text', () => {
  const { value } = new ScorerAssertion(new ExactMatch(), {
    weight: 1,
    threshold: 0,
  });
  const vars = { expected: '{"a": 1}', schema: { type: 'object' } };

  const values = ['The answer is a = 1.', '{"a": 1', ''].map((output) =>
    value(output, { vars }),
  );

  assert.deepEqual(values, [0, 0, 0]);
});

test('a test is refused when its expected value is missing or not JSON text', () => {
  const { value } = new ScorerAssertion(new ExactMatch(), {
    weight: 1,
    threshold: 0,
  });
  const schema = { type: 'object' };

  assert.throws(
    () => value('{"a": 1}', { vars: { schema } }),
    /expected as JSON text/,
  );
  assert.throws(
    () => value('{"a": 1}', { vars: { expected: { a: 1 }, schema } }),
    /expected as JSON text/,
  );
  assert.throws(
    () => value('{"a": 1}', { vars: { expected: '{"a": 1', schema } }),
    SyntaxError,
  );
});

// ADR 0011: a case has its JSON Schema only when the scorers need one, so
// only a scorer that reads the schema refuses a test without one.
test('a test without a schema is refused by a scorer that reads the schema, and scored by one that does not', () => {
  const options = { weight: 1, threshold: 0 };
  const exact = new ScorerAssertion(new ExactMatch(), options);
  const valid = new ScorerAssertion(new SchemaCompliance(), options);
  const vars = { expected: '{"a": 1}' };

  assert.equal(exact.value('{"a": 1}', { vars }), 1);
  assert.throws(
    () => valid.value('{"a": 1}', { vars }),
    /The case has no JSON Schema/,
  );
});

test('the answer and the expected value are read as json.loads reads their text: 7.0 is a float, so it equals 7.0 but not 7', () => {
  const { value } = new ScorerAssertion(new ExactMatch(), {
    weight: 1,
    threshold: 0,
  });
  const vars = { expected: '{"a": 7.0}', schema: { type: 'object' } };

  assert.equal(value('{"a": 7.0}', { vars }), 1);
  assert.equal(value('{"a": 7}', { vars }), 0);
  const intVars = { expected: '{"a": 7}', schema: { type: 'object' } };
  assert.equal(value('{"a": 7}', { vars: intVars }), 1);
  assert.equal(value('{"a": 7.0}', { vars: intVars }), 0);
});

test('the schema of a test is read as a JSON value: a schema that requires a key decides compliance', () => {
  const { value } = new ScorerAssertion(new SchemaCompliance(), {
    weight: 1,
    threshold: 1,
  });
  const vars = {
    expected: '{"a": 1}',
    schema: { type: 'object', required: ['a'] },
  };

  assert.equal(value('{"a": 1}', { vars }), 1);
  assert.equal(value('{}', { vars }), 0);
});

test('canonical equality has no gate: an answer equal to the expected value scores 1 when it breaks the schema', () => {
  const { value } = new ScorerAssertion(new ExactMatch(), {
    weight: 1,
    threshold: 0,
  });
  const vars = {
    expected: '{"a": "x"}',
    schema: { type: 'object', properties: { a: { type: 'integer' } } },
  };

  assert.equal(value('{"a": "x"}', { vars }), 1);
});

test('the assertion gives the value of the ratio of its scorer: an F1 with the bits of f1_from_counts, 0.33333333333333337 and not 1/3', () => {
  const { value } = new ScorerAssertion(new F1(new PathMatches()), {
    weight: 1,
    threshold: 0,
  });
  const vars = { expected: '{"a": 1}', schema: { type: 'object' } };

  const f1 = value('{"a": 1, "b": 2, "c": 3, "d": 4, "e": 5}', { vars });

  assert.equal(f1, 0.33333333333333337);
});
