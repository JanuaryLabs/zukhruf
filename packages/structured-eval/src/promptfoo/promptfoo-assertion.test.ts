import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CanonicalEquality,
  JsonCase,
  JsonTextCase,
  JsonTextScorer,
  LeafExactMatch,
  LeafTokenF1,
  MetricScorer,
  RecordCase,
  RecordScorer,
  RecordSpec,
} from '../index.ts';
import { PromptfooAssertion } from './index.ts';

test('grade gives each ratio as a named score with its whole as the weight, with one component per field', () => {
  const grade = new PromptfooAssertion(
    new RecordScorer(new RecordSpec()),
    RecordCase,
  ).grade;

  const result = grade(
    { a: 1, b: 3 },
    { config: { expected: { a: 1, b: 2 } } },
  );

  assert.equal(result.pass, false);
  assert.equal(result.score, 0.5);
  assert.equal(result.reason, 'b: expected 2, stated 3');
  assert.equal(result.namedScores?.['recall'], 0.5);
  assert.equal(result.namedScoreWeights?.['recall'], 2);
  assert.equal(result.namedScores?.['b recall'], 0);
  assert.equal(result.namedScoreWeights?.['b recall'], 1);
  assert.deepEqual(result.componentResults, [
    { pass: true, score: 1, reason: 'a: 1 right of 1 expected and 1 stated' },
    { pass: false, score: 0, reason: 'b: 0 right of 1 expected and 1 stated' },
  ]);
});

test('the weight of a row weighs its named scores, and a row without one weighs 1', () => {
  const grade = new PromptfooAssertion(
    new MetricScorer({ 'leaf exact match': new LeafExactMatch() }),
    JsonCase,
  ).grade;
  const config = { expected: { a: 'x' }, schema: { type: 'object' } };

  const weights = [undefined, 2, 3].map(
    (weight) =>
      grade(
        { a: 'x' },
        { config: weight === undefined ? config : { ...config, weight } },
      ).namedScoreWeights?.['leaf exact match'],
  );

  assert.deepEqual(weights, [1, 2, 3]);
});

test('a row without config.expected fails with a message that names it', () => {
  const grade = new PromptfooAssertion(
    new RecordScorer(new RecordSpec()),
    RecordCase,
  ).grade;

  assert.throws(() => grade({ a: 1 }, { config: {} }), /config\.expected/);
});

test('a row that gives its expected value as JSON text keeps 7.0 a float, as json.loads reads it', () => {
  const grade = new PromptfooAssertion(
    new JsonTextScorer(
      new MetricScorer({
        'canonical equality': new CanonicalEquality(),
        'leaf token f1': new LeafTokenF1(),
      }),
    ),
    JsonTextCase,
  ).grade;

  const result = grade('{"a": 7.0}', {
    config: { expected: '{"a": 7.0}', schema: {} },
  });

  assert.equal(result.namedScores?.['canonical equality'], 1);
  assert.equal(result.namedScores?.['leaf token f1'], 1);
  assert.throws(
    () => grade('{}', { config: { expected: { a: 7 }, schema: {} } }),
    /expected as JSON text/,
  );
});
