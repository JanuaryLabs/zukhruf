import { Counts } from '../aggregation/counts.ts';
import type { Matches } from '../scorers/matches.ts';
import type { LabelComparison } from './label-comparison.ts';

// The counts of every class in one answer: the hits are the labels that both
// sides have, the stated and the expected are the labels of each side.
// Pooled over the answers, they are scikit-learn's micro counts.
export class AllClassMatches implements Matches<LabelComparison> {
  counts({ stated, expected }: LabelComparison): Counts {
    return new Counts({
      hits: stated.intersection(expected).size,
      stated: stated.size,
      expected: expected.size,
    });
  }
}
