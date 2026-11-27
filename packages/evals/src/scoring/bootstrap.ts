import {
  type ConfidenceInterval,
  type ConfidenceIntervalMethod,
  IidBootstrap,
} from '@zukhruf/statistics';

import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import type { Ratio } from '../aggregation/ratio.ts';
import { type Run, runTests } from './run.ts';

// The bootstrap interval of one name over one run (ADR 0010): each resample
// draws as many tests as the run has, with replacement, in the order of their
// first add. A test is the mean of its epochs times the weight of its case,
// and the statistic is the ratio of sums of those ratios: the statistic of
// Totals, and of PairedBootstrap for one run. The scorer decides the average,
// so the bootstrap never changes a ratio. The caller gives the random
// generator, the number of resamples and the method of the interval, such as
// SOB's (structured ADR 0010). The generator keeps its state between calls,
// so the order of the calls is the order of the draws.
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

  interval(run: Run, name: string): ConfidenceInterval {
    const tests = runTests(run);
    if (tests.size > 0 && !tests.values().some((test) => test.gives(name)))
      throw new Error(`No scorecard of the run gave a ratio named "${name}"`);
    const units = tests
      .values()
      .map((test) => test.mean(name).times(test.weight))
      .toArray();
    return this.#bootstrap.interval(
      units,
      (resample: readonly Ratio[]) => RatioOfSums.of(resample).value,
      this.#interval,
    );
  }
}
