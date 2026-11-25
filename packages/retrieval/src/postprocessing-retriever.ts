import type { Postprocessor } from './postprocessor.ts';
import { type QueryType, needOf } from './query-bundle.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Runs its postprocessors, in order, on the result of its retriever, as
 * LangChain's `ContextualCompressionRetriever` runs its compressor and
 * LlamaIndex runs its `node_postprocessors` (ADR 0008). The retriever gets
 * the query unchanged. Each postprocessor gets the list of the one before it,
 * the information need (`query` of the bundle, ADR 0013) and the abort signal
 * of the call.
 */
export class PostprocessingRetriever<
  Q extends QueryType = QueryType,
> implements Retriever<Q> {
  readonly #retriever: Retriever<Q>;
  readonly #postprocessors: readonly Postprocessor[];

  constructor(options: {
    readonly retriever: Retriever<Q>;
    readonly postprocessors: readonly Postprocessor[];
  }) {
    this.#retriever = options.retriever;
    this.#postprocessors = options.postprocessors;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    const signal =
      options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal };
    let passages = await this.#retriever.retrieve(query, options);
    const need = needOf(query);
    for (const postprocessor of this.#postprocessors) {
      passages = await postprocessor.postprocess(passages, need, signal);
    }
    return passages;
  }
}
