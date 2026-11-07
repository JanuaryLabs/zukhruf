import type { Ratio } from '../aggregation/ratio.ts';
import type { Scorer } from '../scorers/scorer.ts';

// A scorer for each group of an input: in a ScorerSet, it gives the ratio of
// its scorer on each group, under the label `${group} ${label}`. A subclass
// gives the groups (Template Method). A group gives no ratio when the scorer
// counts nothing in it (the whole 0): a ratio with the whole 0 adds nothing
// to a ratio of sums, so the totals stay the same.
export abstract class Grouped<Input> {
  readonly #scorer: Scorer<Input>;

  constructor(scorer: Scorer<Input>) {
    this.#scorer = scorer;
  }

  protected abstract groups(input: Input): Iterable<[string, Input]>;

  ratios(input: Input, label: string): [string, Ratio][] {
    return [...this.groups(input)]
      .map(([group, part]): [string, Ratio] => [
        `${group} ${label}`,
        this.#scorer.score(part),
      ])
      .filter(([, ratio]) => ratio.whole !== 0);
  }
}
