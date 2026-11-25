import type { Passage } from './passage.ts';
import type { RankedPassage } from './ranked-passage.ts';

/**
 * A passage with its score: a finite number, higher is better (ADR 0005). A
 * scored passage is a ranked passage, so a scored list goes where an order
 * is accepted.
 */
export type ScoredPassage<P extends Passage = Passage> = RankedPassage<P> & {
  readonly score: number;
};
