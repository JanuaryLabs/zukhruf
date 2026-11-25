import type { Passage } from './passage.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Changes a result list after the search: it reranks, cuts, diversifies,
 * groups, reorders or widens the passages (ADR 0008). `P` is a parameter of
 * the port, not of `postprocess`: a host's postprocessor is written for its
 * own passage type and gives back passages of that type with no assertion.
 * The package's postprocessors take any passage type they can serve, as
 * their `postprocess` is generic: `ContextWindow` and `Collapse` any
 * `StoredPassage`, the others any `Passage` (ADR 0015).
 */
export interface Postprocessor<in out P extends Passage = Passage> {
  readonly postprocess: (
    passages: readonly ScoredPassage<P>[],
    query: string,
    options?: { readonly abortSignal?: AbortSignal },
  ) => Promise<ScoredPassage<P>[]>;
}
