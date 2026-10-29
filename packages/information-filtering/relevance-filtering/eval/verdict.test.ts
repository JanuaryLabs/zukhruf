import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verdict } from './verdict.ts';

const above = { observed: 0.2, low: 0.1, high: 0.3 };

test('the ranker passes when it is not worse than the keyword list by more than 0.05 MAP and beats the broad list and newest first', () => {
  const outcome = verdict({
    keywordNarrow: { observed: 0.03, low: -0.049, high: 0.1 },
    keywordBroad: above,
    newest: above,
  });

  assert.equal(outcome.result, 'pass');
});

test('each of the three conditions alone fails the ranker', () => {
  const pass = {
    keywordNarrow: { observed: 0.03, low: -0.04, high: 0.1 },
    keywordBroad: above,
    newest: above,
  };
  const failures = [
    { ...pass, keywordNarrow: { observed: 0, low: -0.05, high: 0.1 } },
    { ...pass, keywordBroad: { observed: 0.1, low: 0, high: 0.2 } },
    { ...pass, newest: { observed: 0.1, low: -0.1, high: 0.2 } },
  ];

  assert.deepEqual(
    failures.map((intervals) => verdict(intervals).result),
    ['fail', 'fail', 'fail'],
  );
});
