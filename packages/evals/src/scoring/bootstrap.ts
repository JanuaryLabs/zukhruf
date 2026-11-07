import {
  type ConfidenceInterval,
  type ConfidenceIntervalMethod,
  IidBootstrap,
} from '@zukhruf/statistics';

import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import { Ratio } from '../aggregation/ratio.ts';
import type { Scorecard } from './scorecard.ts';

export type WeightedScorecard = {
  readonly scorecard: Scorecard;
  readonly weight: number;
};

// The bootstrap interval of the mean of one name over many scorecards: each
// resample draws as many scorecards as there are, with replacement, and gives
// the ratio of sums of the name, each scorecard with its weight. The caller
// gives the random generator, the number of resamples and the method of the
// interval, such as SOB's (ADR 0010). The generator keeps its state between
// calls, so the order of the calls is the order of the draws.
export class Bootstrap {
  readonly #bootstrap: IidBootstrap;
  readonly #interval: ConfidenceIntervalMethod;

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
  }

  interval(
    rows: readonly WeightedScorecard[],
    name: string,
  ): ConfidenceInterval {
    return this.#bootstrap.interval(
      rows,
      (resample) => Bootstrap.#mean(resample, name),
      this.#interval,
    );
  }

  static #mean(rows: readonly WeightedScorecard[], name: string): number {
    return RatioOfSums.of(
      rows.map(({ scorecard, weight }) => {
        const ratio = scorecard.ratios.get(name);
        if (ratio === undefined)
          throw new Error(`No scorecard ratio named "${name}"`);
        return new Ratio(ratio.value, 1).times(weight);
      }),
    ).value;
  }
}
