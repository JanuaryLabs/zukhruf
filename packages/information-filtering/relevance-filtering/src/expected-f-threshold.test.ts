import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ExpectedFThreshold, Scores } from './index.ts';

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

describe('ExpectedFThreshold', () => {
  test('beta sets how much recall counts against precision: a larger beta accepts more articles', () => {
    // Accepting the m most probable has the expected F-beta
    // (1 + b²) * (sum of their p) / (b² * 2.5 + m). It is highest at m = 2
    // for b = 0.5 (0.810), at m = 3 for b = 1 (0.836), and at m = 4 for
    // b = 2 (0.893). With b in place of b², b = 0.5 and b = 2 both give m = 3.
    const scores = scored(0.9, 0.8, 0.6, 0.2);

    assert.deepEqual(scores.accepted(new ExpectedFThreshold({ beta: 0.5 })), [
      'p0.9',
      'p0.8',
    ]);
    assert.deepEqual(scores.accepted(new ExpectedFThreshold({ beta: 1 })), [
      'p0.9',
      'p0.8',
      'p0.6',
    ]);
    assert.deepEqual(scores.accepted(new ExpectedFThreshold({ beta: 2 })), [
      'p0.9',
      'p0.8',
      'p0.6',
      'p0.2',
    ]);
  });

  test('accepts the m that maximises the expected F0.5 exactly, also when two m nearly tie', () => {
    // Expected F0.5 with the sum of all p 2.55: m = 2 gives
    // 1.25 * 1.85 / (0.6375 + 2) = 0.8768, m = 3 gives
    // 1.25 * 2.55 / (0.6375 + 3) = 0.8763.
    const scores = scored(0.95, 0.9, 0.7);

    assert.deepEqual(scores.accepted(new ExpectedFThreshold({ beta: 0.5 })), [
      'p0.95',
      'p0.9',
    ]);
  });

  test('a stream with no probability above 0 accepts nothing', () => {
    const threshold = new ExpectedFThreshold({ beta: 0.5 });

    assert.deepEqual(scored(0).accepted(threshold), []);
    assert.equal(threshold.cut(scored(0)), Infinity);
  });
});
