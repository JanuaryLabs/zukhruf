import type { Scorer } from '../scorers/scorer.ts';
import { Grouped } from '../scoring/grouped.ts';
import type { LabelComparison } from './label-comparison.ts';
import type { Label } from './label.ts';

// A scorer for each class of a comparison: in a ScorerSet, it gives the ratio
// of its scorer on the comparison of each class, under the label
// `${class} ${label}`. Without labels, the classes are the labels of both
// sides of the answer; with labels, only those classes.
export class PerClass extends Grouped<LabelComparison> {
  readonly #labels: readonly Label[] | undefined;

  constructor(
    scorer: Scorer<LabelComparison>,
    { labels }: { readonly labels?: readonly Label[] } = {},
  ) {
    super(scorer);
    this.#labels = labels;
  }

  protected *groups(
    comparison: LabelComparison,
  ): Iterable<[string, LabelComparison]> {
    for (const label of this.#labels ?? comparison.labels())
      yield [`${label}`, comparison.only(label)];
  }
}
