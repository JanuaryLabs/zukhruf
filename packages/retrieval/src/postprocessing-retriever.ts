import { untilAborted } from '@zukhruf/async';

import type { Passage } from './passage.ts';
import type { Postprocessor } from './postprocessor.ts';
import { type QueryType, needOf } from './query-bundle.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Runs its postprocessors, in order, on the result of its retriever, as
 * LangChain's `ContextualCompressionRetriever` runs its compressor and
 * LlamaIndex runs its `node_postprocessors` (ADR 0008). The retriever gets
 * the query unchanged. Each postprocessor gets the list of the one before it,
 * the information need (`query` of the bundle, ADR 0013) and the abort signal
 * of the call. Each postprocessor takes the passage type of the retriever,
 * so `ContextWindow` goes only over a retriever of stored passages (ADR
 * 0015). The failures of the retriever pass up unchanged (ADR 0014). When
 * the caller aborts, the call rejects at once with the signal's reason,
 * whatever the retriever and the postprocessors do (ADR 0017).
 */
export class PostprocessingRetriever<
  in Q extends QueryType = QueryType,
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
> implements Retriever<Q, P> {
  readonly #retriever: Retriever<Q, P>;
  readonly #postprocessors: readonly Postprocessor<P>[];

  constructor(options: {
    readonly retriever: Retriever<Q, P>;
    // `NoInfer`: P comes from the retriever only. A postprocessor of the
    // package is generic in its method, so it takes P from there (ADR 0015).
    readonly postprocessors: readonly Postprocessor<NoInfer<P>>[];
  }) {
    this.#retriever = options.retriever;
    this.#postprocessors = options.postprocessors;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P>> {
    const { signal } = options;
    signal?.throwIfAborted();
    return untilAborted(this.#postprocess(query, options), signal);
  }

  async #postprocess(
    query: Q,
    options: RetrieveOptions<P>,
  ): Promise<RetrievalResult<P>> {
    const signal =
      options.signal === undefined ? {} : { signal: options.signal };
    const result = await this.#retriever.retrieve(query, options);
    let passages: readonly ScoredPassage<P>[] = result.passages;
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
