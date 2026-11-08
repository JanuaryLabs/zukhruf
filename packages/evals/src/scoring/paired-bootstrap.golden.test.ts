import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import { PairedBootstrap, Ratio, Run, type Scorecard } from '../index.ts';

// fixtures/paired-bootstrap/expected.json holds the paired bootstrap of the
// README ("Compare two runs") as NumPy 2.5.4 and CPython 3.12.9 compute it:
// generate.py makes it. Its cases give a better, a worse and an inconclusive
// verdict, for a name where higher is better and for one where lower is
// better, and an interval of [0, 0]. Each add is [test id, {name: [part, whole]}, weight].
type Add = readonly [
  string,
  Readonly<Record<string, [number, number]>>,
  number,
];
type Case = {
  readonly case: string;
  readonly name: string;
  readonly higherIsBetter: boolean;
  readonly seed: number;
  readonly nResamples: number;
  readonly baseline: readonly Add[];
  readonly change: readonly Add[];
  readonly verdict: {
    readonly name: string;
    readonly result: string;
    readonly difference: {
      readonly observed: number;
      readonly low: number;
      readonly high: number;
    };
    readonly p: number;
    readonly improvements: number;
    readonly regressions: number;
    readonly ties: number;
    readonly tests: number;
  };
};
const { cases }: { readonly cases: readonly Case[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/paired-bootstrap/expected.json'),
    'utf8',
  ),
);

const runOf = (adds: readonly Add[]) => {
  const run = new Run();
  for (const [testId, ratios, weight] of adds) {
    const scorecard: Scorecard = {
      passed: true,
      score: 0,
      reason: '',
      ratios: new Map(
        Object.entries(ratios).map(([name, [part, whole]]) => [
          name,
          new Ratio(part, whole),
        ]),
      ),
      checks: [],
    };
    run.add(testId, scorecard, weight);
  }
  return run;
};

for (const fixture of cases)
  test(`PairedBootstrap gives the verdict of NumPy to the last bit: ${fixture.case}`, () => {
    const generator = defaultRng(fixture.seed);
    const paired = new PairedBootstrap({
      nResamples: fixture.nResamples,
      randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
      interval: new PercentileInterval({
        low: 0.025,
        high: 0.975,
        method: new Linear(),
      }),
    });

    const verdict = paired.verdict(
      runOf(fixture.baseline),
      runOf(fixture.change),
      fixture.name,
      { higherIsBetter: fixture.higherIsBetter },
    );

    assert.deepEqual(
      {
        ...verdict,
        difference: {
          observed: verdict.difference.observed,
          low: verdict.difference.low,
          high: verdict.difference.high,
        },
      },
      fixture.verdict,
    );
  });
