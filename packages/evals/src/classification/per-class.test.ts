import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recall, ScorerSet } from '../index.ts';
import {
  AllClassMatches,
  LabelCase,
  LabelComparer,
  PerClass,
} from './index.ts';

test("PerClass names the classes in the order of numpy's unique(), by code point: U+FFFF before 😀, which UTF-16 puts after it", () => {
  const scorer = new ScorerSet(
    { recall: new PerClass(new Recall(new AllClassMatches())) },
    { comparer: new LabelComparer() },
  );

  const scorecard = scorer.score(
    ['😀', 'b'],
    new LabelCase({ expected: ['\u{FFFF}', '😀', 'a'], weight: 1 }),
  );

  assert.deepEqual(
    [...scorecard.ratios].map(([name, ratio]) => [name, ratio.part]),
    [
      ['a recall', 0],
      ['\u{FFFF} recall', 0],
      ['😀 recall', 1],
    ],
  );
});

test('PerClass with labels gives only the ratios of those classes, in their order', () => {
  const scorer = new ScorerSet(
    {
      recall: new PerClass(new Recall(new AllClassMatches()), {
        labels: [3, 1],
      }),
    },
    { comparer: new LabelComparer() },
  );

  const scorecard = scorer.score(
    [1, 2],
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
