import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Precision, Recall, ScorerSet } from '../index.ts';
import {
  AllClassMatches,
  LabelCase,
  LabelComparer,
  PerClass,
} from './index.ts';

test('PerClass gives a ratio only for the classes of the class set of the comparer, in its order: a stated or expected label outside it has no column', () => {
  const scorer = new ScorerSet(
    { recall: new PerClass(new Recall(new AllClassMatches())) },
    { comparer: new LabelComparer({ labels: [3, 1] }) },
  );

  const scorecard = scorer.score(
    [1, 2, 9],
    new LabelCase({ expected: [1, 2, 3], weight: 1 }),
  );

  assert.deepEqual(
    [...scorecard.ratios].map(([name, ratio]) => [name, ratio.part]),
    [
      ['3 recall', 0],
      ['1 recall', 1],
    ],
  );
});

test('PerClass gives no column for a class of the class set that no answer states and no case expects, and a column for a class that only the answer states', () => {
  const scorer = new ScorerSet(
    { precision: new PerClass(new Precision(new AllClassMatches())) },
    { comparer: new LabelComparer({ labels: ['a', 'b', 'c'] }) },
  );

  const scorecard = scorer.score(
    'b',
    new LabelCase({ expected: 'a', weight: 1 }),
  );

  assert.deepEqual(
    [...scorecard.ratios].map(([name, ratio]) => [
      name,
      ratio.part,
      ratio.whole,
    ]),
    [['b precision', 0, 1]],
  );
});
