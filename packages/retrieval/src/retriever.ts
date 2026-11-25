import type { Passage } from './passage.ts';
import type { QueryType } from './query-bundle.ts';
import type { RankedPassage } from './ranked-passage.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';

/**
 * The port of the package: any source can implement it (ADR 0002). It gives
 * a retrieval result: passages, best first, and the failures. A retriever
 * that needs a field of its own declares it in its query type,
 * `QueryBundle & { readonly jql: string }`, and then takes no string (ADR
 * 0013). `P` is the passage type it gives: an engine gives `StoredPassage`,
 * a live source `Passage` (ADR 0015). `I` is the item it gives:
 * `RankedPassage<P>`, an order only, or `ScoredPassage<P>`, which every
 * engine gives. A scored retriever is a ranked one, and a ranked retriever
 * is not a scored one.
 */
export interface Retriever<
  in Q extends QueryType = QueryType,
  P extends Passage = Passage,
  out I extends RankedPassage<P> = RankedPassage<P>,
> {
  // A function-typed property, not a method: TypeScript checks the parameter
  // of a method both ways, so a retriever that needs its own field would pass
  // as a plain one (ADR 0013). `P` has no variance annotation: the filter
  // puts it in a parameter too, so `out P` does not hold (ADR 0015). `I` is
  // only in the result, so `out I` holds.
  readonly retrieve: (
    query: Q,
    options?: RetrieveOptions<P>,
  ) => Promise<RetrievalResult<P, I>>;
}
