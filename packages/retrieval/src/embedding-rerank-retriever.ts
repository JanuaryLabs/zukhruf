import { type EmbeddingModel, embed, embedMany } from 'ai';

import { untilAborted } from '@zukhruf/async';
import { Vector, cosineSimilarity } from '@zukhruf/vectors';

import type { Passage } from './passage.ts';
import { type QueryType, needOf } from './query-bundle.ts';
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
 * options of the call unchanged, and may give an order only. The model embeds
 * the information need (`query` of the bundle, ADR 0013) and the text of each
 * passage, in two calls that run at once. Each passage gets the cosine
 * similarity of its vector to the query's as its score, from -1 to 1, best
 * first, a tie in the order of the retriever, and the vector the model made,
 * never one its retriever gave (ADR 0010), so `MaximalMarginalRelevance` with
 * the same model can follow it. It keeps the passages whose score is at
 * least the `scoreThreshold` (ADR 0019), then the best `topN`. A cosine that
 * is not finite, as from a zero vector, is a `TypeError` that names the
 * query or the passage. An empty list makes
 * no model call. The failures of the retriever pass up unchanged (ADR 0014).
 * The retriever and the model get the signal of the call; when it aborts,
 * the call rejects at once with its reason, whatever they do (ADR 0017).
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

  constructor(options: {
    readonly retriever: Retriever<Q, P>;
    /** The model that embeds the query and the text of each passage. */
    readonly model: EmbeddingModel;
    /** How many passages it keeps, best first: every passage when absent. */
    readonly topN?: number;
    /** The least cosine similarity that a passage keeps, from -1 to 1: every passage when absent (ADR 0019). */
    readonly scoreThreshold?: number;
  }) {
    const { topN } = options;
    if (topN !== undefined && !(Number.isInteger(topN) && topN >= 1)) {
      throw new RangeError(`The topN is a positive integer, not ${topN}`);
    }
    this.#threshold = ScoreThreshold.of(options.scoreThreshold);
    this.#retriever = options.retriever;
    this.#model = options.model;
    this.#topN = topN;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P, ScoredPassage<P>>> {
    const { signal } = options;
    signal?.throwIfAborted();
    return untilAborted(this.#rerank(query, options), signal);
  }

  async #rerank(
    query: Q,
    options: RetrieveOptions<P>,
  ): Promise<RetrievalResult<P, ScoredPassage<P>>> {
    const { passages, failures } = await this.#retriever.retrieve(
      query,
      options,
    );
    if (passages.length === 0) return { passages: [], failures };
    // The call rejected already; a retriever that ignored the signal must
    // not start the model calls.
    options.signal?.throwIfAborted();
    // The AI SDK names the signal `abortSignal`.
    const abortSignal =
      options.signal === undefined ? {} : { abortSignal: options.signal };
    const [{ embedding }, { embeddings }] = await Promise.all([
      embed({ model: this.#model, value: needOf(query), ...abortSignal }),
      embedMany({
        model: this.#model,
        values: passages.map(({ passage }) => passage.text),
        ...abortSignal,
      }),
    ]);
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
      return { passage, score, vector };
    });
    const reranked = this.#threshold
      .keep(scored)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, this.#topN);
    return { passages: reranked, failures };
  }
}
