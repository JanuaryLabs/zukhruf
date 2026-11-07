import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recall, ScorerSet } from '../index.ts';
import {
  AllMatched,
  ConfigCase,
  ExactMatch,
  PerField,
  TextVarsCase,
  TokenF1,
  TreeWalk,
  ValueMatches,
} from '../structured/index.ts';
import { PromptfooAssertion } from './index.ts';

test('grade gives each ratio as a named score with its whole as the weight, the field ratios of a PerField too, and one component for each gate', () => {
  const grade = new PromptfooAssertion(
    new ScorerSet(
      {
        perfect: new AllMatched(),
        recall: new Recall(new ValueMatches()),
        'by field': new PerField(new Recall(new ValueMatches())),
      },
      { comparer: new TreeWalk() },
    ),
    new ConfigCase(),
  ).grade;

  const result = grade(
    { a: 1, b: 3 },
    { config: { expected: { a: 1, b: 2 } } },
  );

  assert.equal(result.pass, false);
  assert.equal(result.score, 0.25);
  assert.equal(result.reason, 'perfect: $.b: expected 2, stated 3');
  assert.deepEqual(result.namedScores, {
    perfect: 0,
    recall: 0.5,
    '$.a by field': 1,
    '$.b by field': 0,
  });
  assert.deepEqual(result.namedScoreWeights, {
    perfect: 1,
    recall: 2,
    '$.a by field': 1,
    '$.b by field': 1,
  });
  assert.deepEqual(result.componentResults, [
    { pass: false, score: 0, reason: 'perfect: $.b: expected 2, stated 3' },
  ]);
});

test('the weight of a row weighs its named scores, and a row without one weighs 1', () => {
  const grade = new PromptfooAssertion(
    new ScorerSet(
      {
        'leaf exact match': new Recall(new ValueMatches()),
      },
      { comparer: new TreeWalk() },
    ),
    new TextVarsCase(),
  ).grade;
  const config = { expected: '{"a": "x"}', schema: { type: 'object' } };

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
    new ScorerSet(
      { recall: new Recall(new ValueMatches()) },
      { comparer: new TreeWalk() },
    ),
    new ConfigCase(),
  ).grade;

  assert.throws(() => grade({ a: 1 }, { config: {} }), /config\.expected/);
});

test('a row that gives its expected value as JSON text keeps 7.0 a float, as json.loads reads it', () => {
  const grade = new PromptfooAssertion(
    new ScorerSet(
      {
        'canonical equality': new ExactMatch(),
        'leaf token f1': new TokenF1({ whenNoWords: 1, absentAs: null }),
      },
      { comparer: new TreeWalk() },
    ),
    new TextVarsCase(),
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
