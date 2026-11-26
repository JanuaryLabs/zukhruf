import { type EmbeddingModel, embed, embedMany } from 'ai';

import { untilAborted } from '@zukhruf/async';
import { Vector, cosineSimilarity } from '@zukhruf/vectors';

import { positiveInteger } from './count.ts';
import { fanOut } from './fan-out.ts';
import type { Passage } from './passage.ts';
import { type QueryType, needOf, wordedNeed } from './query-bundle.ts';
import { RankWindow } from './rank-window.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import { ScoreThreshold } from './score-threshold.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Reranks the passages of its retriever by meaning with an embedding model
 * when the query runs, as LangChain's `EmbeddingsFilter` does inside a
 * `ContextualCompressionRetriever` (ADR 0022, #5586). It is the reranker for
 * a host with an embedding model and no reranking model, and for a live
 * source, which has no stored vectors. Its retriever gets the query and the
 * options of the call with the rank window as their `topK` and without
 * `includeVectors`, since it embeds the passages itself (ADR 0023), and may
 * give an order only. The model embeds the information need (`query` of
 * the bundle, ADR 0013) and the text of each passage, in two calls that run
 * at once. Each passage gets the cosine similarity of its vector to the
 * query's as its score, from -1 to 1, best first, a tie in the order of the
 * retriever. A call with `includeVectors: true` also gets the vector the
 * model made with each passage, never one its retriever gave (ADR 0010), and
 * a call without it gets no vector, as every retriever gives one only when
 * asked. So `MaximalMarginalRelevance` with the same model follows it in a
 * `PostprocessingRetriever` called with `includeVectors: true`, which passes
 * the option down, as over an engine. It keeps the passages whose score is
 * at least the `scoreThreshold` (ADR 0019), then the best `topN`, and the
 * call gives the best `topK` of them (ADR 0006). A window smaller than the
 * `topK` of the call is a `RangeError`, and so is an information need that
 * is empty or white space only, before the retriever or the model is called;
 * a `topK` of 0 gives no passages and calls neither (ADR 0023). A cosine that
 * is not finite, as from a zero vector, is a `TypeError` that names the
 * query or the passage. An empty list makes no model call. The failures of the
 * retriever pass up unchanged (ADR 0014). The retriever and the model get
 * the signal of the call; when it aborts, the call rejects at once with its
 * reason, whatever they do (ADR 0017).
 */
export class EmbeddingRerankRetriever<
  in Q extends QueryType = QueryType,
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
> implements Retriever<Q, P, ScoredPassage<P>> {
  readonly #retriever: Retriever<Q, P>;
  readonly #model: EmbeddingModel;
  readonly #topN: number | undefined;
  readonly #threshold: ScoreThreshold;
  readonly #window: RankWindow;

  constructor(options: {
    readonly retriever: Retriever<Q, P>;
    /** The model that embeds the query and the text of each passage. */
    readonly model: EmbeddingModel;
    /**
     * How many passages the retriever gives to the model: the `topK` of the
     * call when absent. A positive integer, at least that `topK`, as
     * Elasticsearch's `rank_window_size` is at least `size` (ADR 0023).
     */
    readonly rankWindowSize?: number;
    /** How many passages it keeps, best first: every passage when absent. */
    readonly topN?: number;
    /** The least cosine similarity that a passage keeps, from -1 to 1: every passage when absent (ADR 0019). */
    readonly scoreThreshold?: number;
  }) {
    const { topN } = options;
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
    // It embeds the passages with its own model, so it never asks its
    // retriever for vectors; filter and signal pass down unchanged.
    const { includeVectors = false, ...asked } = options;
    return await this.#rerank(
      query,
      need,
      { ...asked, topK: call.window },
      call.topK,
      includeVectors,
    );
  }

  async #rerank(
    query: Q,
    need: string,
    options: RetrieveOptions<P>,
    topK: number,
    includeVectors: boolean,
  ): Promise<RetrievalResult<P, ScoredPassage<P>>> {
    // The retriever may ignore its signal: the caller's abort rejects at
    // once, and fanOut covers the model calls.
    const { passages, failures } = await untilAborted(
      this.#retriever.retrieve(query, options),
      options.signal,
    );
    if (passages.length === 0) return { passages: [], failures };
    // The call rejected already; a retriever that ignored the signal must
    // not start the model calls.
    options.signal?.throwIfAborted();
    // A failing call aborts the other, so no model call goes on after the
    // call failed (ADR 0014). One list: the vector of the query, then the
    // vector of each passage; embed always gives one vector, and an empty
    // one would fail the check of the query's vector below.
    const [embedding = [], ...embeddings] = (
      await fanOut(options.signal, [
        async (abortSignal) => [
          (await embed({ model: this.#model, value: need, abortSignal }))
            .embedding,
        ],
        async (abortSignal) =>
          (
            await embedMany({
              model: this.#model,
              values: passages.map(({ passage }) => passage.text),
              abortSignal,
            })
          ).embeddings,
      ])
    ).flat(1);
    const queryVector = Vector.from(embedding);
    // A zero vector has no cosine similarity, even with itself.
    const self = cosineSimilarity(queryVector, queryVector);
    if (!Number.isFinite(self)) {
      throw new TypeError(
        `EmbeddingRerankRetriever scores by cosine similarity, and the vector of the query has the cosine similarity ${self} with itself: a score is a finite number`,
      );
    }
    const scored = passages.map(({ passage }, index) => {
      // embedMany refuses a model that gives another count of embeddings
      // than texts (AI_InvalidResponseDataError), so no index lacks one.
      const vector = embeddings[index] ?? [];
      const score = cosineSimilarity(Vector.from(vector), queryVector);
      if (!Number.isFinite(score)) {
        throw new TypeError(
          `EmbeddingRerankRetriever scores by cosine similarity, and the passage ${passage.id} has the score ${score}: a score is a finite number`,
        );
      }
      // A vector only for a call that asks for one (RetrieveOptions), as
      // MaximalMarginalRelevance after it does.
      return includeVectors ? { passage, score, vector } : { passage, score };
    });
    const reranked = this.#threshold
      .keep(scored)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, this.#topN)
      .slice(0, topK);
    return { passages: reranked, failures };
  }
}
