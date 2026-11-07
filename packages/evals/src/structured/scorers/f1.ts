import { F1Ratio } from '../../aggregation/f1-ratio.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { Matches } from './matches.ts';
import type { Scorer } from './scorer.ts';

// The F1 of the hits: an F1Ratio of the counts.
export class F1 implements Scorer {
  readonly #matches: Matches;

  constructor(matches: Matches) {
    this.#matches = matches;
  }

  score(comparison: Comparison): F1Ratio {
    return new F1Ratio(this.#matches.counts(comparison));
  }
}
