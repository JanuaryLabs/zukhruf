import { type LanguageModel, generateText } from 'ai';

import { type QueryBundle, type QueryType, bundleOf } from './query-bundle.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

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
 */
export class HydeRetriever implements Retriever {
  readonly #retriever: Retriever<QueryBundle>;
  readonly #model: LanguageModel;

  constructor(options: {
    readonly retriever: Retriever<QueryBundle>;
    readonly model: LanguageModel;
  }) {
    this.#retriever = options.retriever;
    this.#model = options.model;
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    const bundle = bundleOf(query);
    const { text } = await generateText({
      model: this.#model,
      prompt: `Please write a passage to answer the question
Question: ${bundle.query}
Passage:`,
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
    });
    return this.#retriever.retrieve(
      { ...bundle, customEmbeddings: [text] },
      options,
    );
  }
}
