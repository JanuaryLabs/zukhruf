import type { Passage } from './passage.ts';

/**
 * A passage in a list of order only: its place in the list is its rank, and
 * a list is best first (ADR 0016). It has no score, as a live source such as
 * a web search or PubMed's Best Match gives an order only. Its vector is
 * there when the call asks for it.
 */
export type RankedPassage<P extends Passage = Passage> = {
  readonly passage: P;
  readonly vector?: readonly number[];
};
