import {
  type ConfidenceIntervalMethod,
  DifferenceInterval,
  IidBootstrap,
} from '@zukhruf/statistics';

import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import type { Ratio } from '../aggregation/ratio.ts';
import { type Run, pairTests, runTests } from './run.ts';

export type Verdict = {
  readonly name: string;
  readonly result: 'better' | 'worse' | 'inconclusive';
  // change − baseline: its observed value and its interval.
  readonly difference: DifferenceInterval;
  // The two-sided percentile-bootstrap p-value, with no correction.
  readonly p: number;
  readonly improvements: number;
  readonly regressions: number;
  readonly ties: number;
  readonly tests: number;
};

// One test in the two runs: the mean of its epochs in each run, and the weight
// of its case.
type Pair = {
  readonly baseline: Ratio;
  readonly change: Ratio;
  readonly weight: number;
};

// The paired bootstrap of two runs on the same tests (Koehn 2004): each
// resample draws as many tests as there are, with replacement, and gives the
// ratio of sums of the name over the change minus the same over the baseline,
// on the same tests. The verdict reads the interval of these differences
// against 0, in the direction of the name (ADR 0004). The generator keeps its
// state between calls, so the order of the calls is the order of the draws.
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
    const pairs = PairedBootstrap.#pairs(baseline, change, name);
    const distribution = this.#bootstrap.distribution(
      pairs,
      PairedBootstrap.#difference,
    );
    const interval = this.#interval.of(distribution);
    const difference = new DifferenceInterval(
      interval.low,
      interval.high,
      PairedBootstrap.#difference(pairs),
    );
    const direction = higherIsBetter ? 1 : -1;
    const signs = pairs.map((pair) =>
      Math.sign((pair.change.value - pair.baseline.value) * direction),
    );
    return {
      name,
      result: PairedBootstrap.#result(difference, higherIsBetter),
      difference,
      p: this.#p(distribution),
      improvements: signs.filter((sign) => sign > 0).length,
      regressions: signs.filter((sign) => sign < 0).length,
      ties: signs.filter((sign) => sign === 0).length,
      tests: pairs.length,
    };
  }

  // Two times the smaller share of the differences at or below 0 and at or
  // above 0, at most 1, as mteb's pairedBootstrapTest gives it.
  #p(distribution: readonly number[]): number {
    const share = (side: (value: number) => boolean) =>
      distribution.filter(side).length / this.#nResamples;
    return Math.min(
      1,
      2 *
        Math.min(
          share((value) => value <= 0),
          share((value) => value >= 0),
        ),
    );
  }

  static #result(
    difference: DifferenceInterval,
    higherIsBetter: boolean,
  ): Verdict['result'] {
    const [better, worse] = higherIsBetter
      ? [difference.isAbove(0), difference.isBelow(0)]
      : [difference.isBelow(0), difference.isAbove(0)];
    if (better) return 'better';
    if (worse) return 'worse';
    return 'inconclusive';
  }

  static #difference(pairs: readonly Pair[]): number {
    return (
      RatioOfSums.of(pairs.map((pair) => pair.change.times(pair.weight)))
        .value -
      RatioOfSums.of(pairs.map((pair) => pair.baseline.times(pair.weight)))
        .value
    );
  }

  // The tests of the two runs, paired by test id in the order of the
  // baseline's first adds (pairTests), with the mean of the epochs of each.
  static #pairs(baseline: Run, change: Run, name: string): Pair[] {
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
    return joined.map((test) => ({
      baseline: test.baseline.mean(name),
      change: test.change.mean(name),
      weight: test.baseline.weight,
    }));
  }
}
