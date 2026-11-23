import type { Passage } from './passage.ts';

/** A passage with its score, and its vector when the call asks for it. */
export type ScoredPassage = {
  readonly passage: Passage;
  /** Higher is better, for every retriever (ADR 0005). */
  readonly score: number;
  readonly vector?: readonly number[];
};
