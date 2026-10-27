import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bcubedScore, pairScore } from './metrics.ts';

test('pair scores count each unordered pair once: c-d joined right, a-b joined wrong, a-c and a-d missed', () => {
  // Four reports: gold events x = {a, c, d} and y = {b}; the detector made
  // the groups {a, b} and {c, d}.
  const gold = new Map([
    ['a', 'x'],
    ['b', 'y'],
    ['c', 'x'],
    ['d', 'x'],
  ]);
  const predicted = new Map([
    ['a', '1'],
    ['b', '1'],
    ['c', '2'],
    ['d', '2'],
  ]);
  const score = pairScore(gold, predicted);

  assert.deepEqual(
    [score.truePositives, score.falsePositives, score.falseNegatives],
    [1, 1, 2],
  );
  assert.equal(score.precision, 1 / 2);
  assert.equal(score.recall, 1 / 3);
  // 1.25 TP / (1.25 TP + FP + 0.25 FN) = 1.25 / 2.75
  assert.equal(score.f05, 1.25 / 2.75);
});

test('a pair filter scores only the pairs it keeps, as for pairs of two publishers', () => {
  // Four reports: gold events x = {a, c, d} and y = {b}; the detector made
  // the groups {a, b} and {c, d}.
  const gold = new Map([
    ['a', 'x'],
    ['b', 'y'],
    ['c', 'x'],
    ['d', 'x'],
  ]);
  const predicted = new Map([
    ['a', '1'],
    ['b', '1'],
    ['c', '2'],
    ['d', '2'],
  ]);
  const publisher = new Map([
    ['a', 'p'],
    ['b', 'q'],
    ['c', 'p'],
    ['d', 'q'],
  ]);

  const score = pairScore(
    gold,
    predicted,
    (a, b) => publisher.get(a) !== publisher.get(b),
  );

  // The kept pairs are a-b (false join), a-d (missed), c-d (joined right)
  // and b-c (apart in both).
  assert.deepEqual(
    [score.truePositives, score.falsePositives, score.falseNegatives],
    [1, 1, 1],
  );
  assert.equal(score.precision, 1 / 2);
  assert.equal(score.recall, 1 / 2);
});

test('a partition that joins nothing has no pair precision and a pair F0.5 of 0', () => {
  // Four reports: gold events x = {a, c, d} and y = {b}; the detector made
  // the groups {a, b} and {c, d}.
  const gold = new Map([
    ['a', 'x'],
    ['b', 'y'],
    ['c', 'x'],
    ['d', 'x'],
  ]);
  const predicted = new Map([
    ['a', '1'],
    ['b', '1'],
    ['c', '2'],
    ['d', '2'],
  ]);
  const alone = new Map([...gold.keys()].map((id) => [id, id]));

  const score = pairScore(gold, alone);

  assert.equal(score.precision, null);
  assert.equal(score.recall, 0);
  assert.equal(score.f05, 0);
});

test('b-cubed averages the precision and recall of each report over the reports', () => {
  // Four reports: gold events x = {a, c, d} and y = {b}; the detector made
  // the groups {a, b} and {c, d}.
  const gold = new Map([
    ['a', 'x'],
    ['b', 'y'],
    ['c', 'x'],
    ['d', 'x'],
  ]);
  const predicted = new Map([
    ['a', '1'],
    ['b', '1'],
    ['c', '2'],
    ['d', '2'],
  ]);
  const score = bcubedScore(gold, predicted);

  // Precision: a 1/2, b 1/2, c 1, d 1. Recall: a 1/3, b 1, c 2/3, d 2/3.
  assert.ok(Math.abs(score.precision - 3 / 4) < 1e-12);
  assert.ok(Math.abs(score.recall - 2 / 3) < 1e-12);
  const f05 = (1.25 * (3 / 4) * (2 / 3)) / (0.25 * (3 / 4) + 2 / 3);
  assert.ok(Math.abs(score.f05 - f05) < 1e-12);
});
