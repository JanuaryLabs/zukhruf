import type { Filter } from './filter.ts';
import type { Passage } from './passage.ts';

export type RetrieveOptions<P extends Passage = Passage> = {
  /** The most passages that the call gives: 10 when absent (ADR 0006). */
  readonly topK?: number;
  readonly filter?: Filter<P>;
  /** Gives the vector of each passage: false when absent. */
  readonly includeVectors?: boolean;
  readonly abortSignal?: AbortSignal;
};
