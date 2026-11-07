import type { Counts } from '../aggregation/counts.ts';
import type { Comparison } from '../comparison/comparison.ts';

// The counts of one comparison that Precision, Recall and F1 read: the hits,
// the stated and the expected (Strategy).
export interface Matches {
  counts(comparison: Comparison): Counts;
}
