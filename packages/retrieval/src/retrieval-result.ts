import type { Passage } from './passage.ts';
import type { RetrieverUnavailableError } from './retriever-unavailable-error.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * What a retrieve call gives: the passages, best first, and each child that
 * was unavailable, by name (CONTEXT.md, "Retrieval result"). Every retriever
 * gives `failures`, empty when nothing failed, as every Elasticsearch
 * response has `_shards` and every bleve result has `Status` (ADR 0014).
 */
export type RetrievalResult<P extends Passage = Passage> = {
  readonly passages: readonly ScoredPassage<P>[];
  readonly failures: ReadonlyMap<string, RetrieverUnavailableError>;
};
