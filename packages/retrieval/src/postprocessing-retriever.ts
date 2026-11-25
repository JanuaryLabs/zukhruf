import { untilAborted } from '@zukhruf/async';

import type { Passage } from './passage.ts';
import type { Postprocessor } from './postprocessor.ts';
import { type QueryType, needOf } from './query-bundle.ts';
import type { RankedPassage } from './ranked-passage.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';

/**
 * Runs its postprocessors, in order, on the result of its retriever, as
 * LangChain's `ContextualCompressionRetriever` runs its compressor and
 * LlamaIndex runs its `node_postprocessors` (ADR 0008). The retriever gets
 * the query unchanged. Each postprocessor gets the list of the one before it,
 * the information need (`query` of the bundle, ADR 0013) and the abort signal
 * of the call. It gives the item of its retriever: scored passages over a
 * scored retriever, an order only over a retriever of order only, and each
 * postprocessor takes that kind (#5400). Each postprocessor takes the passage
 * type of the retriever, so `ContextWindow` goes only over a retriever of
 * stored passages (ADR 0015). The failures of the retriever pass up unchanged
 * (ADR 0014). When the caller aborts, the call rejects at once with the
 * signal's reason, whatever the retriever and the postprocessors do (ADR
 * 0017).
 */
export class PostprocessingRetriever<
  in Q extends QueryType = QueryType,
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
  // `in out I`: each postprocessor takes I and gives it back.
  in out I extends RankedPassage<P> = RankedPassage<P>,
> implements Retriever<Q, P, I> {
  readonly #retriever: Retriever<Q, P, I>;
  readonly #postprocessors: readonly Postprocessor<P, I>[];

  constructor(options: {
    readonly retriever: Retriever<Q, P, I>;
    // `NoInfer`: P and I come from the retriever only. A postprocessor of the
    // package is generic in its method, so it takes them from there (ADR
    // 0015).
    readonly postprocessors: readonly Postprocessor<NoInfer<P>, NoInfer<I>>[];
  }) {
    this.#retriever = options.retriever;
    this.#postprocessors = options.postprocessors;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P, I>> {
    const { signal } = options;
    signal?.throwIfAborted();
    return untilAborted(this.#postprocess(query, options), signal);
  }

  async #postprocess(
    query: Q,
    options: RetrieveOptions<P>,
  ): Promise<RetrievalResult<P, I>> {
    const signal =
      options.signal === undefined ? {} : { signal: options.signal };
    const result = await this.#retriever.retrieve(query, options);
    let passages: readonly I[] = result.passages;
    const need = needOf(query);
    for (const postprocessor of this.#postprocessors) {
      // The call rejected already; a postprocessor that ignored the signal
      // must not start the next one, model calls included.
      options.signal?.throwIfAborted();
      passages = await postprocessor.postprocess(passages, need, signal);
    }
    return { passages, failures: result.failures };
  }
}
