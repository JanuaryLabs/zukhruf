import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CanonicalEquality, SchemaCompliance } from '../index.ts';
import { MetricAssertion } from './index.ts';

test('a metric assertion is a promptfoo javascript assertion with its name, weight and threshold', () => {
  const assertion = new MetricAssertion(
    'exact_match',
    new CanonicalEquality(),
    {
      weight: 2,
      threshold: 0.5,
    },
  );

  assert.equal(assertion.type, 'javascript');
  assert.equal(assertion.metric, 'exact_match');
  assert.equal(assertion.weight, 2);
  assert.equal(assertion.threshold, 0.5);
});

test('weight and threshold are both required: a rule without one of them does not type-check', () => {
  type Rule = ConstructorParameters<typeof MetricAssertion>[2];
  const bothRequired: [Rule] extends [Required<Rule>] ? true : false = true;

  assert.equal(bothRequired, true);
});

test('an answer text that is not JSON scores 0 and does not fail the test: prose, cut-off JSON and empty text', () => {
  const { value } = new MetricAssertion(
    'exact_match',
    new CanonicalEquality(),
    { weight: 1, threshold: 0 },
  );
  const vars = { expected: '{"a": 1}', schema: { type: 'object' } };

  const values = ['The answer is a = 1.', '{"a": 1', ''].map((output) =>
    value(output, { vars }),
  );

  assert.deepEqual(values, [0, 0, 0]);
});

test('a test is refused when its expected value is missing or not JSON text', () => {
  const { value } = new MetricAssertion(
    'exact_match',
    new CanonicalEquality(),
    { weight: 1, threshold: 0 },
  );
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

test('a test is refused when it has no schema', () => {
  const { value } = new MetricAssertion(
    'exact_match',
    new CanonicalEquality(),
    { weight: 1, threshold: 0 },
  );

  assert.throws(
    () => value('{"a": 1}', { vars: { expected: '{"a": 1}' } }),
    /needs schema/,
  );
});

test('the answer and the expected value are read as json.loads reads their text: 7.0 is a float, so it equals 7.0 but not 7', () => {
  const { value } = new MetricAssertion(
    'exact_match',
    new CanonicalEquality(),
    { weight: 1, threshold: 0 },
  );
  const vars = { expected: '{"a": 7.0}', schema: { type: 'object' } };

  assert.equal(value('{"a": 7.0}', { vars }), 1);
  assert.equal(value('{"a": 7}', { vars }), 0);
  const intVars = { expected: '{"a": 7}', schema: { type: 'object' } };
  assert.equal(value('{"a": 7}', { vars: intVars }), 1);
  assert.equal(value('{"a": 7.0}', { vars: intVars }), 0);
});

test('the schema of a test is read as a JSON value: a schema that requires a key decides compliance', () => {
  const { value } = new MetricAssertion('valid_json', new SchemaCompliance(), {
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
  const { value } = new MetricAssertion(
    'exact_match',
    new CanonicalEquality(),
    { weight: 1, threshold: 0 },
  );
  const vars = {
    expected: '{"a": "x"}',
    schema: { type: 'object', properties: { a: { type: 'integer' } } },
  };

  assert.equal(value('{"a": "x"}', { vars }), 1);
});
