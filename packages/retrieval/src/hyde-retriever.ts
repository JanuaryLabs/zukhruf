import { type LanguageModel, generateText } from 'ai';

import { untilAborted } from '@zukhruf/async';

import { asksForNoPassages, callTopK } from './count.ts';
import type { Passage } from './passage.ts';
import {
  type QueryBundle,
  type QueryType,
  bundleOf,
  needOf,
  wordedNeed,
} from './query-bundle.ts';
import type { RankedPassage } from './ranked-passage.ts';
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
 * It gives the item of its retriever: scored passages over an engine, an
 * order only over a host's bundle retriever of order only. An information
 * need that is empty or white space only is a `RangeError`, and a `topK` of
 * 0 gives no passages, both before the model or the retriever is called
 * (ADR 0023).
 */
export class HydeRetriever<
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
  out I extends RankedPassage<P> = RankedPassage<P>,
> implements Retriever<QueryType, P, I> {
  readonly #retriever: Retriever<QueryBundle, P, I>;
  readonly #model: LanguageModel;

  constructor(options: {
    readonly retriever: Retriever<QueryBundle, P, I>;
    readonly model: LanguageModel;
  }) {
    this.#retriever = options.retriever;
    this.#model = options.model;
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P, I>> {
    const topK = callTopK(options.topK);
    wordedNeed(needOf(query));
    const { signal } = options;
    // Not redundant: generateText calls the model with an aborted signal.
    signal?.throwIfAborted();
    // A topK of 0 gives no passages, so the model call and the search would
    // reach no caller (ADR 0023).
    if (asksForNoPassages(topK)) return { passages: [], failures: new Map() };
    return untilAborted(this.#search(query, options), signal);
  }

  async #search(
    query: QueryType,
    options: RetrieveOptions<P>,
  ): Promise<RetrievalResult<P, I>> {
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
