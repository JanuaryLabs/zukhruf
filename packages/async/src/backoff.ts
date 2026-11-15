/**
 * The random change to each wait, so that the retries of many callers spread.
 * `d` is the wait without jitter: `min(max, initial · multiplier^retries)`.
 *
 * - `none`: `d`.
 * - `ratio`: `d` ± `ratio · d`, after the cap, for every wait, the first one
 *   too, as cenkalti/backoff's RandomizationFactor and Kubernetes' Jitter do.
 * - `full`: from 0 to `d` (AWS, full jitter).
 * - `equal`: from `d / 2` to `d` (AWS, equal jitter).
 */
export type Jitter =
  | { kind: 'none' }
  | { kind: 'ratio'; ratio: number }
  | { kind: 'full' }
  | { kind: 'equal' };

export interface BackoffOptions {
  /** The wait before the first retry, in milliseconds. */
  initial: number;
  /** The factor of each next wait: 2 doubles it. 1 or more. */
  multiplier: number;
  /** The longest wait without jitter, in milliseconds. `initial` or more. */
  max: number;
  jitter: Jitter;
  /** Gives a number in [0, 1). The default is `Math.random`. */
  random?: (() => number) | undefined;
}

/**
 * A capped exponential back-off. It gives the wait before the next retry from
 * the number of retries before it, and keeps no other state. The caller keeps
 * the count and waits with `delay`.
 */
export class Backoff {
  readonly #initial: number;
  readonly #multiplier: number;
  readonly #max: number;
  readonly #jitter: Jitter;
  readonly #random: () => number;

  constructor(options: BackoffOptions) {
    const { initial, multiplier, max, jitter } = options;
    if (!(initial > 0))
      throw new RangeError(
        `initial must be a positive number of milliseconds, not ${initial}`,
      );
    if (!(multiplier >= 1 && Number.isFinite(multiplier)))
      throw new RangeError(
        `multiplier must be a finite number of 1 or more, not ${multiplier}`,
      );
    if (!(max >= initial && Number.isFinite(max)))
      throw new RangeError(
        `max must be a finite number of initial (${initial}) or more, not ${max}`,
      );
    if (jitter.kind === 'ratio' && !(jitter.ratio > 0 && jitter.ratio <= 1))
      throw new RangeError(
        `ratio must be above 0 and at most 1, not ${jitter.ratio}`,
      );
    this.#initial = initial;
    this.#multiplier = multiplier;
    this.#max = max;
    this.#jitter = jitter;
    this.#random = options.random ?? Math.random;
  }

  /**
   * The wait in milliseconds before the next retry. `retries` is the number
   * of retries before this wait: 0 before the first retry.
   */
  duration(retries: number): number {
    if (!(Number.isInteger(retries) && retries >= 0))
      throw new RangeError(
        `retries must be an integer of 0 or more, not ${retries}`,
      );
    const d = Math.min(this.#max, this.#initial * this.#multiplier ** retries);
    switch (this.#jitter.kind) {
      case 'none':
        return d;
      case 'ratio':
        return d + d * this.#jitter.ratio * (2 * this.#random() - 1);
      case 'full':
        return this.#random() * d;
      case 'equal':
        return d / 2 + (this.#random() * d) / 2;
    }
  }
}
