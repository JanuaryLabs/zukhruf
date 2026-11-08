import { Grouped } from '../scoring/grouped.ts';
import type { LabelComparison } from './label-comparison.ts';

// A scorer for each class of the class set of a comparison: in a ScorerSet,
// it gives the ratio of its scorer on the comparison of each class, under the
// label `${class} ${label}`, in the order of the class set.
export class PerClass extends Grouped<LabelComparison> {
  protected *groups(
    comparison: LabelComparison,
  ): Iterable<[string, LabelComparison]> {
    for (const label of comparison.labels())
      yield [`${label}`, comparison.only(label)];
  }
}
