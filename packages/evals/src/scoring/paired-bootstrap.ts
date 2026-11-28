import {
  type ConfidenceIntervalMethod,
  DifferenceInterval,
  IidBootstrap,
} from '@zukhruf/statistics';

import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import type { Ratio } from '../aggregation/ratio.ts';
import { type Run, pairTests, runTests, testUnit } from './run.ts';

// The verdict of a name on two runs. A tested verdict's result comes from its
// p and the sign of its observed difference (decide), and its interval is
// there to read; an untested verdict has no difference, no interval and no p,
// since no resample, or not the two runs themselves, gave the name a whole in
// both runs (#6267). Both count the tests that the change improves, regresses
// and ties.
export type Verdict = TestedVerdict | UntestedVerdict;

type Counts = {
  readonly name: string;
  readonly improvements: number;
  readonly regressions: number;
  readonly ties: number;
  readonly tests: number;
};

export type TestedVerdict = Counts & {
  readonly result: 'better' | 'worse' | 'inconclusive';
  // change − baseline: its observed value and its interval.
  readonly difference: DifferenceInterval;
  // The two-sided percentile-bootstrap p-value, with no correction.
  readonly p: number;
  // The resamples that the interval and p come from: those where both runs
  // have a value, of the nResamples drawn.
  readonly resamples: number;
  readonly nResamples: number;
};

export type UntestedVerdict = Counts & { readonly result: 'untested' };

// The level at or below which a deciding p-value counts.
const ALPHA = 0.05;

// The result of a test from the p-value that decides it, read in the
// direction of its score: a difference counts when p is at most 0.05, as a
// level-0.05 test rejects (Casella and Berger 2002, Definition 8.3.26; the
// rule of Holm of @zukhruf/statistics), and its sign says better or worse
// (mteb's decide, docs/copied-code.md).
export const decide = (
  p: number,
  observed: number,
  higherIsBetter: boolean,
): TestedVerdict['result'] => {
  if (p > ALPHA) return 'inconclusive';
  return observed * (higherIsBetter ? 1 : -1) > 0 ? 'better' : 'worse';
};

// One test in the two runs: its unit in each run, the mean of its epochs
// times the weight of its case (testUnit).
type Pair = {
  readonly baseline: Ratio;
  readonly change: Ratio;
};

// The paired bootstrap of two runs on the same tests (Koehn 2004): each
// resample draws as many tests as there are, with replacement, and gives the
// ratio of sums of the name over the change minus the same over the baseline,
// on the same tests. The result is decide(p, observed), in the direction of
// the name (ADR 0004), not the side of 0 that the interval lies on: at
// p = 0.05 exactly (50 of 2000 resamples on one side) a percentile bound can
// reach 0 while p counts (#6367). A resample where either run has no whole
// has no difference and is left out, as Bootstrap leaves it out (#6267): the
// interval and p come from the resamples that have one, and p divides by
// their count. Two runs with no such resample, or with no whole in either run
// on all the tests, give an untested verdict. The generator keeps its state
// between calls, so the order of the calls is the order of the draws.
export class PairedBootstrap {
  readonly #bootstrap: IidBootstrap;
  readonly #interval: ConfidenceIntervalMethod;
  readonly #nResamples: number;

  constructor({
    nResamples,
    randomIndex,
    interval,
  }: {
    readonly nResamples: number;
    readonly randomIndex: (n: number) => number;
    readonly interval: ConfidenceIntervalMethod;
  }) {
    this.#bootstrap = new IidBootstrap({ nResamples, randomIndex });
    this.#interval = interval;
    this.#nResamples = nResamples;
  }

  verdict(
    baseline: Run,
    change: Run,
    name: string,
    { higherIsBetter }: { readonly higherIsBetter: boolean },
  ): Verdict {
    const joined = PairedBootstrap.#joined(baseline, change, name);
    const pairs = joined.map((test): Pair => ({
      baseline: testUnit(test.baseline, name),
      change: testUnit(test.change, name),
    }));
    const distribution = this.#bootstrap.distribution(
      pairs,
      PairedBootstrap.#difference,
    );
    const direction = higherIsBetter ? 1 : -1;
    const signs = joined.map((test) =>
      Math.sign(
        (test.change.mean(name).value - test.baseline.mean(name).value) *
          direction,
      ),
    );
    const counts: Counts = {
      name,
      improvements: signs.filter((sign) => sign > 0).length,
      regressions: signs.filter((sign) => sign < 0).length,
      ties: signs.filter((sign) => sign === 0).length,
      tests: pairs.length,
    };
    const observed = PairedBootstrap.#difference(pairs);
    if (observed === undefined || distribution.length === 0)
      return { ...counts, result: 'untested' };
    const interval = this.#interval.of(distribution);
    const p = PairedBootstrap.#p(distribution);
    const difference = new DifferenceInterval(
      interval.low,
      interval.high,
      observed,
    );
    return {
      ...counts,
      result: decide(p, observed, higherIsBetter),
      difference,
      p,
      resamples: distribution.length,
      nResamples: this.#nResamples,
    };
  }

  // Two times the smaller share of the differences at or below 0 and at or
  // above 0, at most 1, as mteb's pairedBootstrapTest gives it. A share is of
  // the resamples that have a difference.
  static #p(distribution: readonly number[]): number {
    const share = (side: (value: number) => boolean) =>
      distribution.filter(side).length / distribution.length;
    return Math.min(
      1,
      2 *
        Math.min(
          share((value) => value <= 0),
          share((value) => value >= 0),
        ),
    );
  }

  // No value when either run has no whole on the pairs.
  static #difference(pairs: readonly Pair[]): number | undefined {
    const change = RatioOfSums.of(pairs.map((pair) => pair.change)).ratio
      .quotient;
    const baseline = RatioOfSums.of(pairs.map((pair) => pair.baseline)).ratio
      .quotient;
    return change === undefined || baseline === undefined
      ? undefined
      : change - baseline;
  }

  // The tests of the two runs, paired by test id in the order of the
  // baseline's first adds (pairTests).
  static #joined(
    baseline: Run,
    change: Run,
    name: string,
  ): ReturnType<typeof pairTests> {
    const joined = pairTests(baseline, change, 'A paired bootstrap');
    const baselineTests = runTests(baseline);
    const changeTests = runTests(change);
    for (const [run, tests] of [
      ['baseline', baselineTests],
      ['change', changeTests],
    ] as const)
      if (!tests.values().some((test) => test.gives(name)))
        throw new Error(
          `No scorecard of the ${run} run gave a ratio named "${name}"`,
        );
    return joined;
  }
}
