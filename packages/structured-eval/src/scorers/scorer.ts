import type { Ratio } from '../aggregation/ratio.ts';
import type { Comparison } from '../comparison/comparison.ts';

// One Ratio for one comparison, such as the expected leaves that the stated
// value has with an equal value, of all expected leaves. A gate is a scorer
// whose ratio is 1 of 1 or 0 of 1.
export interface Scorer {
  score(comparison: Comparison): Ratio;
}
