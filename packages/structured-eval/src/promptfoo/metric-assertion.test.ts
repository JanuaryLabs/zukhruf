import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CanonicalEquality, JsonTextCase, SchemaCompliance } from '../index.ts';
import { MetricAssertion } from './index.ts';

test('an answer text that is not JSON scores 0 and does not fail the test: prose, cut-off JSON and empty text', () => {
  const grade = new MetricAssertion(new CanonicalEquality(), JsonTextCase)
    .grade;
  const vars = { expected: '{"a": 1}', schema: { type: 'object' } };

  const values = ['The answer is a = 1.', '{"a": 1', ''].map((output) =>
    grade(output, { vars }),
  );

  assert.deepEqual(values, [0, 0, 0]);
});

test('a test is refused when its expected value is missing or not JSON text', () => {
  const grade = new MetricAssertion(new CanonicalEquality(), JsonTextCase)
    .grade;
  const schema = { type: 'object' };

  assert.throws(
    () => grade('{"a": 1}', { vars: { schema } }),
    /expected as JSON text/,
  );
  assert.throws(
    () => grade('{"a": 1}', { vars: { expected: { a: 1 }, schema } }),
    /expected as JSON text/,
  );
  assert.throws(
    () => grade('{"a": 1}', { vars: { expected: '{"a": 1', schema } }),
    SyntaxError,
  );
});

test('the answer and the expected value are read as json.loads reads their text: 7.0 is a float, so it equals 7.0 but not 7', () => {
  const grade = new MetricAssertion(new CanonicalEquality(), JsonTextCase)
    .grade;
  const vars = { expected: '{"a": 7.0}', schema: { type: 'object' } };

  assert.equal(grade('{"a": 7.0}', { vars }), 1);
  assert.equal(grade('{"a": 7}', { vars }), 0);
});

test('a test is refused when it has no schema', () => {
  const grade = new MetricAssertion(new CanonicalEquality(), JsonTextCase)
    .grade;

  assert.throws(
    () => grade('{"a": 1}', { vars: { expected: '{"a": 1}' } }),
    /needs schema/,
  );
});

test('the schema of a test is read as a JSON value: a schema that requires a key decides compliance', () => {
  const grade = new MetricAssertion(new SchemaCompliance(), JsonTextCase).grade;
  const vars = {
    expected: '{"a": 1}',
    schema: { type: 'object', required: ['a'] },
  };

  assert.equal(grade('{"a": 1}', { vars }), 1);
  assert.equal(grade('{}', { vars }), 0);
});

test('canonical equality has no gate: an answer equal to the expected value scores 1 when it breaks the schema', () => {
  const grade = new MetricAssertion(new CanonicalEquality(), JsonTextCase)
    .grade;
  const vars = {
    expected: '{"a": "x"}',
    schema: { type: 'object', properties: { a: { type: 'integer' } } },
  };

  assert.equal(grade('{"a": "x"}', { vars }), 1);
});

test('an answer that promptfoo gives as a JavaScript value is scored as that value', () => {
  const grade = new MetricAssertion(new CanonicalEquality(), JsonTextCase)
    .grade;
  const vars = { expected: '{"a": 7}', schema: { type: 'object' } };

  assert.equal(grade({ a: 7 }, { vars }), 1);
});
