import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mainScore, metrics } from './metrics.ts';

const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected ${expected}, got ${actual}`,
  );

const f05 = (precision: number, recall: number) =>
  (1.25 * precision * recall) / (0.25 * precision + recall);

test('each F0.5 follows from the published precision and recall of reference case A4, and CoNLL averages MUC, B-cubed and CEAF-e', () => {
  // TC-A.key against TC-A-4.response: key {a} {bc} {def}, response {a} {bcx}
  // {dy} {z}, as token spans.
  const key = new Map([
    ['0-1', 'a'],
    ['3-6', 'bc'],
    ['9-9', 'bc'],
    ['11-12', 'def'],
    ['14-14', 'def'],
    ['16-18', 'def'],
  ]);
  const response = new Map([
    ['0-1', 'a'],
    ['3-6', 'bcx'],
    ['9-9', 'bcx'],
    ['10-10', 'bcx'],
    ['11-12', 'dy'],
    ['15-15', 'dy'],
    ['13-13', 'z'],
  ]);

  const scores = metrics(key, response);

  // test/TestCases.README: MUC recall 1/3, precision 1/3; B-cubed recall
  // 5/9, precision 17/42; CEAF-e common 2.2, recall 2.2/3, precision 2.2/4;
  // coreference links recall 1/4, precision 1/4.
  close(scores.muc.f05, f05(1 / 3, 1 / 3));
  close(scores.bCubed.f05, f05(17 / 42, 5 / 9));
  close(scores.ceafE.f05, f05(2.2 / 4, 2.2 / 3));
  close(scores.pair.f05, f05(1 / 4, 1 / 4));
  close(
    scores.conll.f1,
    (scores.muc.f1 + scores.bCubed.f1 + scores.ceafE.f1) / 3,
  );
  close(
    scores.conll.f05,
    (f05(1 / 3, 1 / 3) + f05(17 / 42, 5 / 9) + f05(2.2 / 4, 2.2 / 3)) / 3,
  );
  close(mainScore(key, response), scores.conll.f05);
});

test('the BLANC F0.5 is the mean of the F0.5 of the coreference links and of the non-coreference links', () => {
  // TC-A.key against TC-A-4.response; test/TestCases.README gives the links:
  // coreference recall 1/4, precision 1/4; non-coreference recall 5/11,
  // precision 5/17.
  const key = new Map([
    ['0-1', 'a'],
    ['3-6', 'bc'],
    ['9-9', 'bc'],
    ['11-12', 'def'],
    ['14-14', 'def'],
    ['16-18', 'def'],
  ]);
  const response = new Map([
    ['0-1', 'a'],
    ['3-6', 'bcx'],
    ['9-9', 'bcx'],
    ['10-10', 'bcx'],
    ['11-12', 'dy'],
    ['15-15', 'dy'],
    ['13-13', 'z'],
  ]);

  const { blanc } = metrics(key, response);

  close(blanc.f05, (f05(1 / 4, 1 / 4) + f05(5 / 17, 5 / 11)) / 2);
});

test('pair scores count each unordered pair once: c-d joined right, a-b joined wrong, a-c and a-d missed', () => {
  // Gold events x = {a, c, d} and y = {b}; the detector made {a, b} and
  // {c, d}.
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

  const { pair } = metrics(gold, predicted);

  assert.equal(pair.precision, 1 / 2);
  assert.equal(pair.recall, 1 / 3);
  close(pair.f1, (2 * (1 / 2) * (1 / 3)) / (1 / 2 + 1 / 3));
  close(pair.f05, f05(1 / 2, 1 / 3));
});
