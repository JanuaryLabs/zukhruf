import type { Ratio } from '../../aggregation/ratio.ts';
import type { Scorer } from '../../scorers/scorer.ts';
import type { Comparison } from '../comparison/comparison.ts';

// A scorer for each field of a comparison: in a ScorerSet, it gives the
// ratio of its scorer on the leaf pairs and item pairs of each field, under
// the label `${field} ${label}`, such as `$.offers[*].kind recall`. A field
// gives no ratio when the scorer counts nothing in it (the whole 0): an
// object or an array under a scorer of leaves, or a field whose leaves are
// all null under nullIsMissing. A ratio with the whole 0 adds nothing to a
// ratio of sums, so the totals stay the same.
export class PerField {
  readonly #scorer: Scorer<Comparison>;

  constructor(scorer: Scorer<Comparison>) {
    this.#scorer = scorer;
  }

  ratios(comparison: Comparison, label: string): [string, Ratio][] {
    return comparison
      .fields()
      .map((field): [string, Ratio] => [
        `${field} ${label}`,
        this.#scorer.score(comparison.only(field)),
      ])
      .filter(([, ratio]) => ratio.whole !== 0);
  }
}
