import type { ScoredPassage } from './scored-passage.ts';

/** Combines the result lists of several retrievers into one list, on `Passage.id` (ADR 0007). */
export interface Fusion {
  /** `weights` has one weight for each list, in the order of the lists. */
  fuse(
    lists: readonly (readonly ScoredPassage[])[],
    weights: readonly number[],
  ): ScoredPassage[];
}
