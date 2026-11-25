import type { Passage } from './passage.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Combines the result lists of several retrievers into one list, on
 * `Passage.id` (ADR 0007). `P` is a parameter of the port, not of `fuse`: a
 * host's fusion is written for its own passage type and gives back passages
 * of that type with no assertion (ADR 0015). The package's fusions take any
 * passage type, as their `fuse` is generic.
 */
export interface Fusion<in out P extends Passage = Passage> {
  /** `weights` has one weight for each list, in the order of the lists. */
  readonly fuse: (
    lists: readonly (readonly ScoredPassage<P>[])[],
    weights: readonly number[],
  ) => ScoredPassage<P>[];
}
