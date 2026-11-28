import type { ConfidenceIntervalMethod } from '../interval/confidence-interval-method.ts';
import { BootstrapInterval } from './bootstrap-interval.ts';

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

  // The statistic of each resample that has one, in the order of the
  // resamples. A statistic with no value on a resample, such as a ratio whose
  // resample has no whole, is undefined, and the resample is left out, as R
  // boot's boot.ci keeps only the finite statistics (bootfuns.q of boot
  // 1.3-32: fins <- seq_along(t)[is.finite(t)]). scipy.stats.bootstrap keeps
  // a NaN there, so its interval is NaN.
  distribution<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number | undefined,
  ): number[] {
    if (data.length === 0)
      throw new RangeError('A bootstrap needs at least one item');
    return Array.from({ length: this.#nResamples }, () =>
      statistic(Array.from({ length: data.length }, () => this.#item(data))),
    ).filter((value) => value !== undefined);
  }

  // The interval of the method over the resamples whose statistic has a
  // value, with their count. A statistic that always has one always gives an
  // interval; when no resample has a value, the interval has none.
  interval<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number,
    method: ConfidenceIntervalMethod,
  ): BootstrapInterval;
  interval<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number | undefined,
    method: ConfidenceIntervalMethod,
  ): BootstrapInterval | undefined;
  interval<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number | undefined,
    method: ConfidenceIntervalMethod,
  ): BootstrapInterval | undefined {
    const distribution = this.distribution(data, statistic);
    if (distribution.length === 0) return undefined;
    const { low, high } = method.of(distribution);
    return new BootstrapInterval(low, high, {
      resamples: distribution.length,
      nResamples: this.#nResamples,
    });
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
