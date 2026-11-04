import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import type { Scorecard } from './scorecard.ts';

// The ratio of sums of each name over many scorecards: what a runner keeps
// for a run.
export class Totals {
  readonly #sums = new Map<string, RatioOfSums>();

  add(scorecard: Scorecard, weight: number): void {
    for (const [name, ratio] of scorecard.ratios) {
      const sum = this.#sums.get(name) ?? new RatioOfSums();
      this.#sums.set(name, sum);
      sum.add(ratio.times(weight));
    }
  }

  get(name: string): RatioOfSums {
    const sum = this.#sums.get(name);
    if (sum === undefined)
      throw new Error(`No scorecard gave a ratio named "${name}"`);
    return sum;
  }

  names(): IterableIterator<string> {
    return this.#sums.keys();
  }
}
