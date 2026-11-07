import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Counts, FBeta, RatioOfSums } from '../index.ts';

// A Matches whose input is its own counts.
const counted = { counts: (counts: Counts) => counts };

test("FBeta at β = 0.5 gives the bits of relevance-filtering's T11F, 1.25·tp / (1.25·tp + 0.25·fn + fp), for every integer count up to 30", () => {
  const f05 = new FBeta(counted, { beta: 0.5 });
  const differ: [number, number, number][] = [];

  for (let tp = 0; tp <= 30; tp++)
    for (let fn = 0; fn <= 30; fn++)
      for (let fp = 0; fp <= 30; fp++) {
        const t11f = tp === 0 ? 0 : (1.25 * tp) / (1.25 * tp + 0.25 * fn + fp);
        const value = f05.score(
          new Counts({ hits: tp, stated: tp + fp, expected: tp + fn }),
        ).value;
        if (!Object.is(value, t11f)) differ.push([tp, fn, fp]);
      }

  assert.deepEqual(
    { count: differ.length, first: differ.slice(0, 3) },
    { count: 0, first: [] },
  );
});

test('the ratios of FBeta add up to the micro F-beta: the part is (1 + β²)·hits and the whole is β²·expected + stated', () => {
  const f2 = new FBeta(counted, { beta: 2 });

  const pooled = RatioOfSums.of(
    [
      new Counts({ hits: 1, stated: 2, expected: 4 }),
      new Counts({ hits: 3, stated: 3, expected: 3 }),
    ].map((counts) => f2.score(counts)),
  ).ratio;

  assert.deepEqual([pooled.part, pooled.whole], [20, 33]);
});
