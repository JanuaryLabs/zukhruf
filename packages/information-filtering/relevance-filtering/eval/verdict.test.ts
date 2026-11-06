import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Interval } from './bootstrap.ts';
import { verdict } from './verdict.ts';

const above = new Interval(0.2, 0.1, 0.3);

test('the ranker passes when it is not worse than the keyword list by more than 0.05 MAP and beats the broad list and newest first', () => {
  const outcome = verdict({
    keywordNarrow: new Interval(0.03, -0.049, 0.1),
    keywordBroad: above,
    newest: above,
  });

  assert.equal(outcome.result, 'pass');
});

test('each of the three conditions alone fails the ranker', () => {
  const pass = {
    keywordNarrow: new Interval(0.03, -0.04, 0.1),
    keywordBroad: above,
    newest: above,
  };
  const failures = [
    { ...pass, keywordNarrow: new Interval(0, -0.05, 0.1) },
    { ...pass, keywordBroad: new Interval(0.1, 0, 0.2) },
    { ...pass, newest: new Interval(0.1, -0.1, 0.2) },
  ];

  assert.deepEqual(
    failures.map((intervals) => verdict(intervals).result),
    ['fail', 'fail', 'fail'],
  );
});
