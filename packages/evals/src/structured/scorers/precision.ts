import { Ratio } from '../../aggregation/ratio.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { Matches } from './matches.ts';
import type { Scorer } from './scorer.ts';

// The hits of the stated values: Ratio(hits, stated).
export class Precision implements Scorer {
  readonly #matches: Matches;

  constructor(matches: Matches) {
    this.#matches = matches;
  }

  score(comparison: Comparison): Ratio {
    const { hits, stated } = this.#matches.counts(comparison);
    return new Ratio(hits, stated);
  }
}
