import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verdict } from './verdict.ts';

const above = { observed: 0.2, low: 0.1, high: 0.3 };

test('the design passes when it is not worse than the keyword by more than 0.05, beats the other baselines and is calibrated', () => {
  const outcome = verdict({
    intervals: {
      keywordNarrow: { observed: 0.03, low: -0.049, high: 0.1 },
      keywordBroad: above,
      alwaysNo: above,
      alwaysYes: above,
    },
    macroBrierSkill: 0.4,
  });

  assert.equal(outcome.result, 'pass');
});

test('each of the four conditions alone fails the design', () => {
  const pass = {
    keywordNarrow: { observed: 0.03, low: -0.04, high: 0.1 },
    keywordBroad: above,
    alwaysNo: above,
    alwaysYes: above,
  };
  const failures = [
    {
      intervals: {
        ...pass,
        keywordNarrow: { observed: 0, low: -0.05, high: 0.1 },
      },
      macroBrierSkill: 0.4,
    },
    {
      intervals: {
        ...pass,
        keywordBroad: { observed: 0.1, low: 0, high: 0.2 },
      },
      macroBrierSkill: 0.4,
    },
    {
      intervals: {
        ...pass,
        alwaysYes: { observed: 0.1, low: -0.1, high: 0.2 },
      },
      macroBrierSkill: 0.4,
    },
    { intervals: pass, macroBrierSkill: 0 },
  ];

  assert.deepEqual(
    failures.map((options) => verdict(options).result),
    ['fail', 'fail', 'fail', 'fail'],
  );
});
