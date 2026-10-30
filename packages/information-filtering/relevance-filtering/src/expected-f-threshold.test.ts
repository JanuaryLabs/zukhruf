import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ExpectedFThreshold, Profile, Scores } from './index.ts';

const profile = new Profile({
  name: 'chips',
  description: 'New computer chips.',
  relevant: [],
  notRelevant: [],
});

// The scores of a stream that a scorer ranked, the best first.
function scored(...probabilities: number[]): Scores {
  return new Scores({
    profile,
    ranked: probabilities.map((probability, index) => ({
      id: `p${probability}`,
      publishedAt: new Date(Date.UTC(2026, 9, index + 1)),
      probability,
    })),
  });
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

  test('a stream with no probability above 0 accepts nothing', () => {
    const threshold = new ExpectedFThreshold({ beta: 0.5 });

    assert.deepEqual(scored(0).accepted(threshold), []);
    assert.equal(threshold.cut(scored(0)), Infinity);
  });
});
