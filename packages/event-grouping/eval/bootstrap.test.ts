import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pairedBootstrap } from './bootstrap.ts';
import { mainScore } from './metrics/metrics.ts';

const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected ${expected}, got ${actual}`,
  );

test('the interval of a tiny partition is the one that the three possible draws give', () => {
  // Gold events A = {a1, a2} and B = {b}. The run is the gold; the latest
  // design leaves a1 and a2 apart. Two units are drawn: A and A (1/4), A and
  // B (1/2), B and B (1/4). The run scores 1 on any draw with A (MUC, B-cubed
  // and CEAF-e F0.5 of 1), and B and B is perfect for both designs.
  const gold = new Map([
    ['a1', 'A'],
    ['a2', 'A'],
    ['b', 'B'],
  ]);
  const latest = new Map([
    ['a1', '1'],
    ['a2', '2'],
    ['b', '3'],
  ]);
  // A and A: MUC 0; B-cubed P 1, R 1/2, F0.5 5/6; CEAF-e P 1/3, R 2/3,
  // F0.5 10/27. A and B: MUC 0; B-cubed P 1, R 2/3, F0.5 10/11; CEAF-e
  // P 5/9, R 5/6, F0.5 25/42.
  const twiceA = 1 - (0 + 5 / 6 + 10 / 27) / 3;
  const aAndB = 1 - (0 + 10 / 11 + 25 / 42) / 3;

  const interval = pairedBootstrap({
    gold,
    run: gold,
    latest,
    statistic: mainScore,
    replicates: 2000,
    seed: 1,
  });

  close(interval.observed, aAndB);
  assert.equal(interval.low, 0);
  close(interval.high, twiceA);
});

test('two equal partitions have an interval of exactly 0, because both are scored on the same draws', () => {
  // Gold events A = {a1, a2} and B = {b}; both designs leave a1 and a2
  // apart, so A and B are two units, and draws differ.
  const gold = new Map([
    ['a1', 'A'],
    ['a2', 'A'],
    ['b', 'B'],
  ]);
  const design = new Map([
    ['a1', '1'],
    ['a2', '2'],
    ['b', '3'],
  ]);

  const interval = pairedBootstrap({
    gold,
    run: design,
    latest: new Map(design),
    statistic: mainScore,
    replicates: 2000,
    seed: 1,
  });

  assert.equal(interval.blocks, 2);
  assert.deepEqual([interval.observed, interval.low, interval.high], [0, 0, 0]);
});

test('a false join keeps its two gold events in one unit, so each draw scores the false join as the reports have it', () => {
  // Gold events A = {a} and B = {b}. The run is the gold; the latest design
  // joins a with b. Every draw is the one unit {a, b}, so every replicate is
  // the observed change.
  const gold = new Map([
    ['a', 'A'],
    ['b', 'B'],
  ]);

  const interval = pairedBootstrap({
    gold,
    run: gold,
    latest: new Map([
      ['a', '1'],
      ['b', '1'],
    ]),
    statistic: mainScore,
    replicates: 2000,
    seed: 1,
  });

  assert.ok(interval.observed > 0);
  assert.equal(interval.blocks, 1);
  assert.equal(interval.low, interval.observed);
  assert.equal(interval.high, interval.observed);
});

test('a false join of the run alone also keeps its two gold events in one unit', () => {
  // Gold events A = {a} and B = {b}. The run joins a with b; the latest
  // design is the gold.
  const gold = new Map([
    ['a', 'A'],
    ['b', 'B'],
  ]);

  const interval = pairedBootstrap({
    gold,
    run: new Map([
      ['a', '1'],
      ['b', '1'],
    ]),
    latest: gold,
    statistic: mainScore,
    replicates: 2000,
    seed: 1,
  });

  assert.equal(interval.blocks, 1);
  assert.ok(interval.observed < 0);
  assert.equal(interval.low, interval.observed);
  assert.equal(interval.high, interval.observed);
});

test('the interval is the nearest-rank 2.5th and 97.5th percentile of the replicate differences', () => {
  // The statistic gives the run the number of the replicate (0 to 999) and
  // the latest design 0, so the differences are 0 to 999. The nearest rank
  // of 2.5% of 1000 is the 25th value (24), and of 97.5% the 975th (974).
  const gold = new Map([
    ['a', 'A'],
    ['b', 'B'],
  ]);
  const run = new Map([
    ['a', 'run-a'],
    ['b', 'run-b'],
  ]);
  const latest = new Map([
    ['a', 'latest-a'],
    ['b', 'latest-b'],
  ]);
  let replicate = 0;
  const statistic = (
    _key: ReadonlyMap<string, string>,
    response: ReadonlyMap<string, string>,
  ) => ([...response.values()][0]!.startsWith('run') ? replicate++ : 0);

  const interval = pairedBootstrap({
    gold,
    run,
    latest,
    statistic,
    replicates: 1000,
    seed: 1,
  });

  assert.equal(interval.low, 24);
  assert.equal(interval.high, 974);
});

test('one seed draws the same replicates, so a run can be repeated', () => {
  // Gold events A = {a1, a2}, B = {b} and C = {c}. The statistic of the run
  // records the number of reports of each replicate, which the draw decides.
  const gold = new Map([
    ['a1', 'A'],
    ['a2', 'A'],
    ['b', 'B'],
    ['c', 'C'],
  ]);
  const draws = (seed: number) => {
    const sizes: number[] = [];
    const interval = pairedBootstrap({
      gold,
      run: new Map([...gold].map(([id, event]) => [id, `run-${event}`])),
      latest: gold,
      statistic: (key, response) => {
        if ([...response.values()][0]!.startsWith('run')) sizes.push(key.size);
        return 0;
      },
      replicates: 1000,
      seed,
    });
    return { interval, sizes };
  };

  const first = draws(3182);
  const second = draws(3182);
  const other = draws(1);

  assert.equal(first.sizes.length, 1001);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.sizes, other.sizes);
});
