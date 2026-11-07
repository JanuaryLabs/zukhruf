import { Gate } from '../scorers/gate.ts';
import type { LabelComparison } from './label-comparison.ts';

// A gate that holds when the stated labels are the expected labels. Pooled
// over the answers, it is scikit-learn's accuracy_score (the subset accuracy
// for a set of classes).
export class LabelsMatch extends Gate<LabelComparison> {
  holds({ stated, expected }: LabelComparison): boolean {
    return stated.size === expected.size && stated.isSubsetOf(expected);
  }

  explain(comparison: LabelComparison): string {
    return `the stated labels ${JSON.stringify([...comparison.stated])} are not the expected labels ${JSON.stringify([...comparison.expected])}`;
  }
}
