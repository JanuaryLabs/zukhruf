import type { Counts } from '../aggregation/counts.ts';

// The counts of one input that Precision, Recall and F1 read: the hits, the
// stated and the expected (Strategy).
export interface Matches<Input> {
  counts(input: Input): Counts;
}
