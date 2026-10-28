import assert from 'node:assert/strict';
import { test } from 'node:test';

import { best, crossValidatedChange, objective } from './selection.ts';

test('the best threshold has the highest value, and equal values go to the higher threshold', () => {
  const ascending = best([
    { threshold: 0.4, value: 0.8 },
    { threshold: 0.45, value: 0.82 },
    { threshold: 0.5, value: 0.82 },
    { threshold: 0.55, value: 0.7 },
  ]);
  const descending = best([
    { threshold: 0.55, value: 0.7 },
    { threshold: 0.5, value: 0.82 },
    { threshold: 0.45, value: 0.82 },
    { threshold: 0.4, value: 0.8 },
  ]);

  assert.deepEqual(ascending, { threshold: 0.5, value: 0.82 });
  assert.deepEqual(descending, { threshold: 0.5, value: 0.82 });
});

test('the objective is the mean of the family means, so a family with many folds counts once', () => {
  const families = new Map([
    ['a-0', 'a'],
    ['a-1', 'a'],
    ['a-2', 'a'],
    ['b-0', 'b'],
  ]);

  const all = objective(
    new Map([
      ['a-0', 0.9],
      ['a-1', 0.6],
      ['a-2', 0.6],
      ['b-0', 0.5],
    ]),
    families,
  );
  // An inner cross-validation scores the folds that are not the outer fold.
  const withoutB = objective(
    new Map([
      ['a-0', 0.9],
      ['a-1', 0.6],
      ['a-2', 0.6],
    ]),
    families,
  );

  assert.ok(Math.abs(all - 0.6) < 1e-12, `${all}`);
  assert.ok(Math.abs(withoutB - 0.7) < 1e-12, `${withoutB}`);
});

test('the change of the cross-validated objective keeps the folds apart, even when two folds share report ids and event labels', () => {
  // Two folds with the same ids and labels. The challenger is the gold; the
  // incumbent leaves every report alone.
  const gold = new Map([
    ['a', 'E'],
    ['b', 'E'],
  ]);
  const apart = new Map([
    ['a', '1'],
    ['b', '2'],
  ]);
  const folds = [
    { name: 'x-0', family: 'x', gold },
    { name: 'y-0', family: 'y', gold },
  ];

  const gain = crossValidatedChange({
    folds,
    challenger: new Map([
      ['x-0', gold],
      ['y-0', gold],
    ]),
    incumbent: new Map([
      ['x-0', apart],
      ['y-0', apart],
    ]),
  });
  const none = crossValidatedChange({
    folds,
    challenger: new Map([
      ['x-0', gold],
      ['y-0', gold],
    ]),
    incumbent: new Map([
      ['x-0', gold],
      ['y-0', gold],
    ]),
  });

  assert.equal(gain.blocks, 2);
  assert.ok(gain.low > 0, `${gain.low}`);
  assert.deepEqual([none.observed, none.low, none.high], [0, 0, 0]);
});
