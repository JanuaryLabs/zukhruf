import type { Passage } from './passage.ts';
import type { RetrieveOptions } from './retrieve-options.ts';

/**
 * The checks of a count, each a `RangeError` that names what it counts, so
 * every object of the package refuses a bad count in the same words (#5769,
 * #5772).
 */

/**
 * An option that counts, such as `topN`, `rankWindowSize`, `queryCount` or
 * `windowSize`: a positive integer, or a `RangeError` that names the option.
 */
export function positiveInteger(name: string, value: number): number {
  if (!(Number.isInteger(value) && value >= 1)) {
    throw new RangeError(`The ${name} is a positive integer, not ${value}`);
  }
  return value;
}

/**
 * The topK of a call, 10 when absent (ADR 0006): a whole number of 0 or more,
 * or a `RangeError`, as Elasticsearch refuses a bad `size`. A topK of 0 gives
 * no passages, as `size` 0 does (ADR 0023).
 */
export function callTopK(topK: number | undefined): number {
  const checked = topK ?? 10;
  if (!(Number.isInteger(checked) && checked >= 0)) {
    throw new RangeError(
      `The topK is a whole number of 0 or more, not ${checked}`,
    );
  }
  return checked;
}

/**
 * The options of a call whose topK `callTopK` gave: what each engine's own
 * search takes, so a search cannot run on a topK no entry checked.
 */
export type CheckedRetrieveOptions<P extends Passage> = RetrieveOptions<P> & {
  readonly topK: number;
};
