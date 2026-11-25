import type { Passage } from './passage.ts';
import type { RankedPassage } from './ranked-passage.ts';
import type { RetrieverUnavailableError } from './retriever-unavailable-error.ts';

/**
 * What a retrieve call gives: the passages, best first, and each child that
 * was unavailable, by name (CONTEXT.md, "Retrieval result"). Every retriever
 * gives `failures`, empty when nothing failed, as every Elasticsearch
 * response has `_shards` and every bleve result has `Status` (ADR 0014). `I`
 * is the item of the list: `RankedPassage<P>` for an order only, or
 * `ScoredPassage<P>`.
 */
export type RetrievalResult<
  P extends Passage = Passage,
  I extends RankedPassage<P> = RankedPassage<P>,
> = {
  readonly passages: readonly I[];
  readonly failures: ReadonlyMap<string, RetrieverUnavailableError>;
};
