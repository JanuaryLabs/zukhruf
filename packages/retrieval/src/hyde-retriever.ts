import { type LanguageModel, generateText } from 'ai';

import { untilAborted } from '@zukhruf/async';

import type { Passage } from './passage.ts';
import { type QueryBundle, type QueryType, bundleOf } from './query-bundle.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';

/**
 * Hypothetical document embeddings (HyDE; Gao, Ma, Lin and Callan, 2022):
 * asks the language model for a passage that answers the query, and gives
 * that passage to the embedding search only, as `customEmbeddings: [passage]`
 * (ADR 0008, ADR 0013). `query` and `keywords` stay, so a reranker below
 * still ranks against `query`, as LlamaIndex's `HyDEQueryTransform` keeps
 * `query_str`. Its retriever takes any query bundle, as the one of
 * MultiQueryRetriever takes any query: a host source that needs its own field
 * is fused beside HyDE, not under it, since only an embedding search reads the
 * passage. The prompt is the "websearch"
 * prompt of LangChain's `HydeRetriever`
 * (libs/langchain-classic/src/retrievers/hyde.ts, getPromptTemplateFromKey).
 * The model and the retriever get the signal of the call; when it aborts,
 * the call rejects at once with its reason, whatever they do (ADR 0017).
 */
export class HydeRetriever<
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
> implements Retriever<QueryType, P> {
  readonly #retriever: Retriever<QueryBundle, P>;
  readonly #model: LanguageModel;

  constructor(options: {
    readonly retriever: Retriever<QueryBundle, P>;
    readonly model: LanguageModel;
  }) {
    this.#retriever = options.retriever;
    this.#model = options.model;
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P>> {
    const { signal } = options;
    // Not redundant: generateText calls the model with an aborted signal.
    signal?.throwIfAborted();
    return untilAborted(this.#search(query, options), signal);
  }

  async #search(
    query: QueryType,
    options: RetrieveOptions<P>,
  ): Promise<RetrievalResult<P>> {
    const bundle = bundleOf(query);
    const { text } = await generateText({
      model: this.#model,
      prompt: `Please write a passage to answer the question
Question: ${bundle.query}
Passage:`,
      // The AI SDK names the signal `abortSignal`.
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    return this.#retriever.retrieve(
      { ...bundle, customEmbeddings: [text] },
      options,
    );
  }
}
