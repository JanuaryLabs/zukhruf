import type { Passage } from './passage.ts';

/** A passage with its score when the retriever gives one, and its vector when the call asks for it. */
export type ScoredPassage<P extends Passage = Passage> = {
  readonly passage: P;
  /**
   * Higher is better (ADR 0005). Absent when the retriever gives an order
   * only, as LlamaIndex's `NodeWithScore.score` is optional (ADR 0016).
   */
  readonly score?: number;
  readonly vector?: readonly number[];
};
