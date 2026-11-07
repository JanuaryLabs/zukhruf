import { Counts } from '../aggregation/counts.ts';
import type { Matches } from '../scorers/matches.ts';
import type { LabelComparison } from './label-comparison.ts';
import type { Label } from './label.ts';

// The counts of one class in one answer: the hit is 1 when both sides have
// the label, the stated 1 when the answer has it, the expected 1 when the
// case has it. Pooled over the answers, they are scikit-learn's true
// positives, predicted and true of the class.
export class ClassMatches implements Matches<LabelComparison> {
  readonly #label: Label;

  constructor(label: Label) {
    this.#label = label;
  }

  counts({ stated, expected }: LabelComparison): Counts {
    const isStated = stated.has(this.#label) ? 1 : 0;
    const isExpected = expected.has(this.#label) ? 1 : 0;
    return new Counts({
      hits: isStated * isExpected,
      stated: isStated,
      expected: isExpected,
    });
  }
}
