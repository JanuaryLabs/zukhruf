import type { Counts } from './counts.ts';
import { Ratio } from './ratio.ts';

// The ratio of an F1: its part is 2 × hits and its whole is stated +
// expected, so many F1 ratios add up to the micro F1. Its value is 0 when
// there are no hits, else 2·p·r/(p + r): precision and recall first, the
// arithmetic of SOB's evaluate.py (f1_from_counts, token_f1). That value can
// differ from part / whole in the last bit, such as for 1 hit of 1 expected
// and 5 stated (0.33333333333333337, not 1/3). It is the one exception to the
// rule of a Ratio (ADR 0011).
export class F1Ratio extends Ratio {
  readonly #counts: Counts;

  constructor(counts: Counts) {
    super(2 * counts.hits, counts.stated + counts.expected);
    this.#counts = counts;
  }

  override get value(): number {
    const { hits, stated, expected } = this.#counts;
    if (hits === 0) return 0;
    const precision = hits / stated;
    const recall = hits / expected;
    return (2 * precision * recall) / (precision + recall);
  }
}
