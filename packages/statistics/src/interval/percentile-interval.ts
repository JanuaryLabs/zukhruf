import type { QuantileMethod } from '../quantile/quantile-method.ts';
import type { ConfidenceIntervalMethod } from './confidence-interval-method.ts';
import { ConfidenceInterval } from './confidence-interval.ts';

// The percentile method of scipy.stats.bootstrap: the low and the high
// quantile of a bootstrap distribution, both read with one quantile method,
// as numpy.percentile reads them. It sorts a copy, so the distribution stays
// as it is.
export class PercentileInterval implements ConfidenceIntervalMethod {
  readonly #low: number;
  readonly #high: number;
  readonly #method: QuantileMethod;

  constructor({
    low,
    high,
    method,
  }: {
    readonly low: number;
    readonly high: number;
    readonly method: QuantileMethod;
  }) {
    this.#low = low;
    this.#high = high;
    this.#method = method;
  }

  of(distribution: readonly number[]): ConfidenceInterval {
    const sorted = distribution.toSorted((a, b) => a - b);
    return new ConfidenceInterval(
      this.#method.of(sorted, this.#low),
      this.#method.of(sorted, this.#high),
    );
  }
}
