import { type RerankingModel, rerank } from 'ai';

import { untilAborted } from '@zukhruf/async';

import { positiveInteger } from './count.ts';
import type { Passage } from './passage.ts';
import { type QueryType, needOf, wordedNeed } from './query-bundle.ts';
import { RankWindow } from './rank-window.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import { ScoreThreshold } from './score-threshold.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Reranks the passages of its retriever with a reranking model through the
 * AI SDK's `rerank`, as Elasticsearch's `text_similarity_reranker` retriever
 * reranks a child retriever and LangChain's `ContextualCompressionRetriever`
 * runs a reranker over its base retriever (ADR 0008, #5400). Its retriever
 * gets the query and the options of the call with the rank window as their
 * `topK`, as `text_similarity_reranker` asks its child for
 * `rank_window_size` documents (ADR 0023), and may give an order only; the
 * model gets the text of each passage, the information need (`query` of the
 * bundle, ADR 0013) and `topN`, and without `topN` it ranks every passage.
 * Each passage that the model ranks gets the relevance that the model gives
 * it as its score, higher is better, best first, so it gives scored passages
 * over any retriever. A passage that the model leaves out is dropped, and so
 * is one whose relevance is under the `scoreThreshold` (ADR 0019); the call
 * gives the best `topK` of the rest (ADR 0006). A window smaller than the
 * `topK` of the call is a `RangeError` before the retriever or the model is
 * called, and so is an information need that is empty or white space only;
 * a `topK` of 0 gives no passages and calls neither (ADR 0023).
 * A relevance that is not finite is a `TypeError`: the AI SDK passes
 * the model's `relevanceScore` on unchecked (#5700). An empty list makes no
 * model call, as the AI SDK's `rerank` sends none. The failures of the
 * retriever pass up unchanged (ADR 0014). The retriever and the model get the
 * signal of the call; when it aborts, the call rejects at once with its
 * reason, whatever they do (ADR 0017).
 */
export class RerankRetriever<
  in Q extends QueryType = QueryType,
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
> implements Retriever<Q, P, ScoredPassage<P>> {
  readonly #retriever: Retriever<Q, P>;
  readonly #model: RerankingModel;
  readonly #topN: number | undefined;
  readonly #threshold: ScoreThreshold;
  readonly #window: RankWindow;

  constructor(options: {
    readonly retriever: Retriever<Q, P>;
    readonly model: RerankingModel;
    /**
     * How many passages the retriever gives to the model: the `topK` of the
     * call when absent. A positive integer, at least that `topK`, as
     * Elasticsearch's `rank_window_size` is at least `size` (ADR 0023).
     */
    readonly rankWindowSize?: number;
    /** How many passages the model keeps: every passage when absent. A positive integer. */
    readonly topN?: number;
    /** The least score from the reranking model that a passage keeps: every passage when absent (ADR 0019). */
    readonly scoreThreshold?: number;
  }) {
    const { topN } = options;
    // The AI SDK passes topN to the provider unchecked.
    if (topN !== undefined) positiveInteger('topN', topN);
    this.#threshold = ScoreThreshold.of(options.scoreThreshold);
    this.#window = RankWindow.of(options.rankWindowSize);
    this.#retriever = options.retriever;
    this.#model = options.model;
    this.#topN = topN;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P, ScoredPassage<P>>> {
    const call = this.#window.forCall(options.topK);
    const need = wordedNeed(needOf(query));
    const { signal } = options;
    signal?.throwIfAborted();
    if (call === undefined) return { passages: [], failures: new Map() };
    return untilAborted(
      this.#rerank(query, need, { ...options, topK: call.window }, call.topK),
      signal,
    );
  }

  async #rerank(
    query: Q,
    need: string,
    options: RetrieveOptions<P>,
    topK: number,
  ): Promise<RetrievalResult<P, ScoredPassage<P>>> {
    const { passages, failures } = await this.#retriever.retrieve(
      query,
      options,
    );
    // The call rejected already; a retriever that ignored the signal must
    // not start the model call.
    options.signal?.throwIfAborted();
    const { ranking } = await rerank({
      model: this.#model,
      documents: passages.map(({ passage }) => passage.text),
      query: need,
      ...(this.#topN === undefined ? {} : { topN: this.#topN }),
      // The AI SDK names the signal `abortSignal`.
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    const relevance = new Map(
      ranking.map(({ originalIndex, score }) => [originalIndex, score]),
    );
    const scored = passages.flatMap(({ passage, vector }, index) => {
      const score = relevance.get(index);
      if (score === undefined) return [];
      if (!Number.isFinite(score)) {
        throw new TypeError(
          `RerankRetriever reads scores, and the passage ${passage.id} has the score ${score}: a score is a finite number`,
        );
      }
      return [
        vector === undefined ? { passage, score } : { passage, score, vector },
      ];
    });
    const reranked = this.#threshold
      .keep(scored)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, topK);
    return { passages: reranked, failures };
  }
}
