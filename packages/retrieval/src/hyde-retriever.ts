import { type LanguageModel, generateText } from 'ai';

import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Hypothetical document embeddings (HyDE; Gao, Ma, Lin and Callan, 2022):
 * asks the language model for a passage that answers the query, and searches
 * with that passage as the query (ADR 0008). The prompt is the "websearch"
 * prompt of LangChain's `HydeRetriever`
 * (libs/langchain-classic/src/retrievers/hyde.ts, getPromptTemplateFromKey).
 */
export class HydeRetriever implements Retriever {
  readonly #retriever: Retriever;
  readonly #model: LanguageModel;

  constructor(options: {
    readonly retriever: Retriever;
    readonly model: LanguageModel;
  }) {
    this.#retriever = options.retriever;
    this.#model = options.model;
  }

  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    const { text } = await generateText({
      model: this.#model,
      prompt: `Please write a passage to answer the question
Question: ${query}
Passage:`,
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
    });
    return this.#retriever.retrieve(text, options);
  }
}
