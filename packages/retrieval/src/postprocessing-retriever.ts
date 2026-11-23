import type { Postprocessor } from './postprocessor.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Runs its postprocessors, in order, on the result of its retriever, as
 * LangChain's `ContextualCompressionRetriever` runs its compressor and
 * LlamaIndex runs its `node_postprocessors` (ADR 0008). Each postprocessor
 * gets the list of the one before it, the query and the abort signal of the
 * call.
 */
export class PostprocessingRetriever implements Retriever {
  readonly #retriever: Retriever;
  readonly #postprocessors: readonly Postprocessor[];

  constructor(options: {
    readonly retriever: Retriever;
    readonly postprocessors: readonly Postprocessor[];
  }) {
    this.#retriever = options.retriever;
    this.#postprocessors = options.postprocessors;
  }

  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    const signal =
      options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal };
    let passages = await this.#retriever.retrieve(query, options);
    for (const postprocessor of this.#postprocessors) {
      passages = await postprocessor.postprocess(passages, query, signal);
    }
    return passages;
  }
}
