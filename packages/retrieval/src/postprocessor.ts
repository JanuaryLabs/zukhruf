import type { ScoredPassage } from './scored-passage.ts';

/**
 * Changes a result list after the search: it reranks, cuts, diversifies,
 * groups, reorders or widens the passages (ADR 0008).
 */
export interface Postprocessor {
  postprocess(
    passages: readonly ScoredPassage[],
    query: string,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<ScoredPassage[]>;
}
