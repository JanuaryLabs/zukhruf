import assert from 'node:assert/strict';
import { test } from 'node:test';

import { baselines } from './baselines.ts';
import { mainScore, metrics } from './metrics/metrics.ts';

test('the all-singletons baseline joins nothing: MUC 0 and a B-cubed precision of 1', () => {
  // Gold events x = {a, b} and y = {c}.
  const gold = new Map([
    ['a', 'x'],
    ['b', 'x'],
    ['c', 'y'],
  ]);

  const { allSingletons } = baselines(gold);
  const scores = metrics(gold, allSingletons);

  assert.equal(new Set(allSingletons.values()).size, 3);
  assert.deepEqual(
    [scores.muc.precision, scores.muc.recall, scores.muc.f05],
    [0, 0, 0],
  );
  assert.deepEqual([scores.pair.precision, scores.pair.f05], [0, 0]);
  assert.equal(scores.bCubed.precision, 1);
  // Recall: a 1/2, b 1/2, c 1.
  assert.equal(scores.bCubed.recall, 2 / 3);
});

test('the all-in-one baseline joins every report: MUC and B-cubed recall of 1', () => {
  // Gold events x = {a, b} and y = {c}.
  const gold = new Map([
    ['a', 'x'],
    ['b', 'x'],
    ['c', 'y'],
  ]);

  const { allInOne } = baselines(gold);
  const scores = metrics(gold, allInOne);

  assert.equal(new Set(allInOne.values()).size, 1);
  assert.equal(scores.muc.recall, 1);
  // One right link of two.
  assert.equal(scores.muc.precision, 1 / 2);
  assert.equal(scores.bCubed.recall, 1);
});

test('on mostly singleton events, doing nothing beats a design with one right join and one false join on B-cubed F0.5, but on the main score the design beats both baselines', () => {
  // Eight singleton events and one event {a, b}. The design joins a with b
  // and also c with d.
  const gold = new Map([
    ['a', 'ab'],
    ['b', 'ab'],
    ...['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id) => [id, id] as const),
  ]);
  const design = new Map(
    [...gold].map(([id, event]) => [id, id === 'd' ? 'c' : event]),
  );
  const { allSingletons, allInOne } = baselines(gold);

  const nothing = metrics(gold, allSingletons);
  const joined = metrics(gold, design);

  assert.ok(nothing.bCubed.f05 > joined.bCubed.f05);
  assert.ok(mainScore(gold, design) > mainScore(gold, allSingletons));
  assert.ok(mainScore(gold, design) > mainScore(gold, allInOne));
});
