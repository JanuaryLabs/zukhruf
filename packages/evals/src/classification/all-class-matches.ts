import { Counts } from '../aggregation/counts.ts';
import type { Matches } from '../scorers/matches.ts';
import type { LabelComparison } from './label-comparison.ts';

// The counts of the classes of the class set in one answer: the hits are the
// classes that both sides have, the stated and the expected are the classes
// of each side. A label outside the class set counts in no class. Pooled over
// the answers, they are scikit-learn's micro counts.
export class AllClassMatches implements Matches<LabelComparison> {
  counts(comparison: LabelComparison): Counts {
    const classes = new Set(comparison.labels());
    const stated = comparison.stated.intersection(classes);
    const expected = comparison.expected.intersection(classes);
    return new Counts({
      hits: stated.intersection(expected).size,
      stated: stated.size,
      expected: expected.size,
    });
  }
}
