import type { Ratio } from '../aggregation/ratio.ts';
import type { Scorer } from '../scorers/scorer.ts';

// A scorer for each group of an input: in a ScorerSet, it gives the ratio of
// its scorer on each group, under the label `${group} ${label}`, and stays
// out of the score of the record, as a breakdown is not a score of its own.
// A subclass gives the groups (Template Method): a part of the input, such as
// one class, or a projection of it, such as the stated items of one kind. A
// group gives no ratio when the scorer counts nothing in it (the whole 0): a
// ratio with the whole 0 adds nothing to a ratio of sums, so the totals stay
// the same.
export abstract class Grouped<Input, Group = Input> {
  readonly #scorer: Scorer<Group>;

  constructor(scorer: Scorer<Group>) {
    this.#scorer = scorer;
  }

  protected abstract groups(input: Input): Iterable<[string, Group]>;

  ratios(input: Input, label: string): [string, Ratio][] {
    return [...this.groups(input)]
      .map(([group, part]): [string, Ratio] => [
        `${group} ${label}`,
        this.#scorer.score(part),
      ])
      .filter(([, ratio]) => ratio.whole !== 0);
  }
}
