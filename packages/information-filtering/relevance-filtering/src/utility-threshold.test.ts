import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Scores, UtilityThreshold } from './index.ts';

// The scores of a stream that a scorer ranked, the best first.
function scored(...probabilities: number[]): Scores {
  return new Scores(
    new Map(
      probabilities.map((probability, index) => [
        `p${probability}`,
        { publishedAt: new Date(Date.UTC(2026, 9, index + 1)), probability },
      ]),
    ),
  );
}

describe('UtilityThreshold', () => {
  test('accepts an article when its expected cost of a miss is at least its expected cost of a false alarm: p >= falseAlarm / (falseAlarm + miss)', () => {
    const scores = scored(0.9, 0.5, 0.25, 0.2499, 0.1);

    assert.deepEqual(
      scores.accepted(new UtilityThreshold({ falseAlarm: 1, miss: 3 })),
      ['p0.9', 'p0.5', 'p0.25'],
    );
    assert.deepEqual(
      scores.accepted(new UtilityThreshold({ falseAlarm: 1, miss: 1 })),
      ['p0.9', 'p0.5'],
    );
    assert.equal(new UtilityThreshold({ falseAlarm: 3, miss: 1 }).cut(), 0.75);
  });

  test('a false alarm that costs nothing accepts every article, and a miss that costs nothing accepts only certain ones', () => {
    const scores = scored(1, 0.99, 0);

    assert.deepEqual(
      scores.accepted(new UtilityThreshold({ falseAlarm: 0, miss: 1 })),
      ['p1', 'p0.99', 'p0'],
    );
    assert.deepEqual(
      scores.accepted(new UtilityThreshold({ falseAlarm: 1, miss: 0 })),
      ['p1'],
    );
  });

  test('costs that give no threshold are a RangeError: a negative cost, two costs of 0, or a cost that is not a finite number', () => {
    for (const costs of [
      { falseAlarm: -1, miss: 2 },
      { falseAlarm: 1, miss: -0.5 },
      { falseAlarm: 0, miss: 0 },
      { falseAlarm: Number.NaN, miss: 1 },
      { falseAlarm: 1, miss: Infinity },
    ])
      assert.throws(
        () => new UtilityThreshold(costs),
        RangeError,
        JSON.stringify(costs),
      );
  });
});
