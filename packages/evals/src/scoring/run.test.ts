import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { Ratio, Run, Totals } from '../index.ts';

test('the total of a name is the ratio of sums of each test, its epochs averaged and its weight applied, not of the scorecards', () => {
  const run = new Run();
  const totals = new Totals();
  const scorecards: [string, Ratio, number][] = [
    ['a', new Ratio(1, 1), 3],
    ['a', new Ratio(0, 3), 3],
    ['a', new Ratio(1, 2), 3],
    ['b', new Ratio(1, 2), 1],
  ];
  for (const [testId, ratio, weight] of scorecards) {
    const scorecard = { ratios: new Map([['recall', ratio]]) };
    run.add(testId, scorecard, weight);
    totals.add(scorecard, weight);
  }

  const total = run.total('recall');

  // a is Ratio(2 / 3, 2) times 3, Ratio(2, 6), and b is Ratio(1, 2): 3 / 8.
  // Totals adds the three epochs of a as three scorecards: 7 / 20.
  assert.deepEqual(
    { total: total.value, totals: totals.get('recall').value },
    { total: 3 / 8, totals: 7 / 20 },
  );
});

test('a name that no test of the run gives throws, and names the name', () => {
  const run = new Run();
  run.add('a', { ratios: new Map([['recall', new Ratio(1, 1)]]) }, 1);

  assert.throws(() => run.total('precision'), {
    name: 'Error',
    message: 'No scorecard of the run gave a ratio named "precision"',
  });
});
