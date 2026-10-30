import assert from 'node:assert/strict';
import { test } from 'node:test';

import { articleWeights, percentile, topicBootstrap } from './bootstrap.ts';

test('a percentile interpolates as numpy.percentile', () => {
  const sorted = [0.1, 0.2, 0.33, 0.5, 0.9];

  assert.deepEqual(
    [2.5, 50, 97.5].map((q) => percentile(sorted, q)),
    [0.11000000000000001, 0.33, 0.86],
  );
});

// numpy 2.5.4: np.percentile(np.arange(2000) / 997, [2.5, 97.5]). numpy puts
// the 97.5th percentile at (n - 1) * (q / 100) = 1949.0249999999999, not at
// 1949.025.
test('a percentile takes its position as numpy does, (n - 1) * (q / 100)', () => {
  const sorted = Array.from({ length: 2000 }, (_, index) => index / 997);

  assert.deepEqual(
    [2.5, 97.5].map((q) => percentile(sorted, q)),
    [0.050125376128385156, 1.954889669007021],
  );
});

// The values come from round-2 evaluate.py topic_boot with numpy 2.3.4.
test('the topic bootstrap gives the interval of the research code for the same differences and seed', () => {
  const differences = [0.1, -0.05, 0.2, 0.03, 0, 0.12, -0.2, 0.07, 0.15, 0.01];

  const interval = topicBootstrap(differences, 31957);

  assert.deepEqual(interval, {
    observed: 0.043000000000000003,
    low: -0.026000000000000006,
    high: 0.10402499999999987,
  });
});

test('each replicate of the article bootstrap draws as many articles of each stratum as the stratum holds', () => {
  const relevantToAny = [true, false, false, true, false, false, false];

  const weights = articleWeights(relevantToAny, 31958);

  assert.equal(weights.length, 2000);
  for (const row of weights) {
    const drawn = (inStratum: boolean) =>
      row.reduce(
        (sum, weight, index) =>
          relevantToAny[index] === inStratum ? sum + weight : sum,
        0,
      );
    assert.deepEqual([drawn(true), drawn(false)], [2, 5]);
  }
});
