import type { Passage } from './passage.ts';
import type { RankedPassage } from './ranked-passage.ts';

/**
 * Changes a result list after the search: it cuts, diversifies, groups,
 * reorders or widens the passages (ADR 0008). `P` and `I` are parameters of
 * the port, not of `postprocess`: a host's postprocessor is written for its
 * own passage type and kind, `RankedPassage<P>` (an order only) or
 * `ScoredPassage<P>`, and gives back items of that kind with no assertion. So
 * a host postprocessor of order only, such as a pin that adds a passage
 * without a score, does not go over a scored retriever, and one that reads
 * scores does not go over a list of order only (#5400). The package's
 * postprocessors keep the kind they get, as their `postprocess` is generic:
 * `ContextWindow<M>` takes any `StoredPassage<M>` of its store, `Collapse<P>`
 * any `P`, the others any `Passage` (ADR 0015).
 */
export interface Postprocessor<
  in out P extends Passage = Passage,
  in out I extends RankedPassage<P> = RankedPassage<P>,
> {
  readonly postprocess: (
    passages: readonly I[],
    query: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<I[]>;
}
