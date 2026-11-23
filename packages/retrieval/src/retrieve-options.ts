import type { Filter } from './filter.ts';

export type RetrieveOptions = {
  /** The most passages that the call gives: 10 when absent (ADR 0006). */
  readonly topK?: number;
  readonly filter?: Filter;
  /** Gives the vector of each passage: false when absent. */
  readonly includeVectors?: boolean;
  readonly abortSignal?: AbortSignal;
};
