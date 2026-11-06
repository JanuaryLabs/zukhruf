import type { ConfidenceIntervalMethod } from '../interval/confidence-interval-method.ts';
import type { ConfidenceInterval } from '../interval/confidence-interval.ts';

// The bootstrap of arch.bootstrap.IIDBootstrap: resamples of independent
// items, drawn with replacement. The caller's generator gives each random
// index, one call for each item, in order, resample by resample, as a Python
// loop over the same generator draws them.
export class IidBootstrap {
  readonly #nResamples: number;
  readonly #randomIndex: (n: number) => number;

  constructor({
    nResamples,
    randomIndex,
  }: {
    readonly nResamples: number;
    readonly randomIndex: (n: number) => number;
  }) {
    this.#nResamples = nResamples;
    this.#randomIndex = randomIndex;
  }

  // The bootstrap distribution of scipy.stats.bootstrap: the statistic of
  // each resample, in the order of the resamples.
  distribution<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number,
  ): number[] {
    if (data.length === 0)
      throw new RangeError('A bootstrap needs at least one item');
    return Array.from({ length: this.#nResamples }, () =>
      statistic(Array.from({ length: data.length }, () => this.#item(data))),
    );
  }

  interval<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number,
    method: ConfidenceIntervalMethod,
  ): ConfidenceInterval {
    return method.of(this.distribution(data, statistic));
  }

  #item<T>(data: readonly T[]): T {
    const index = this.#randomIndex(data.length);
    const item = data[index];
    if (item === undefined)
      throw new RangeError(
        `A random index is from 0 to ${data.length - 1}, not ${index}`,
      );
    return item;
  }
}
