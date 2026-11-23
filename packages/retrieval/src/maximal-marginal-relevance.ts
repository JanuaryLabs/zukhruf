import { type EmbeddingModel, embed } from 'ai';

import { Vector, cosineSimilarity } from '@zukhruf/vectors';

import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';
import { VectorMissingError } from './vector-missing-error.ts';

/**
 * Maximal marginal relevance (Carbonell and Goldstein, SIGIR 1998): picks
 * `topK` passages one at a time, each with the best
 * `lambda * relevance - (1 - lambda) * redundancy`. The relevance is the
 * cosine similarity of the passage's vector to the query's vector, and the
 * redundancy is the passage's highest cosine similarity to a passage picked
 * before. The first pick is the most relevant passage. A tie goes to the
 * passage that comes first in the list. This is LangChain's
 * `maximalMarginalRelevance` (libs/langchain-core/src/utils/math.ts). The
 * model embeds the query, as Haystack's `SentenceTransformersDiversityRanker`
 * embeds it (ADR 0008, the proposed amendment of 2026-11-23).
 *
 * The passages come back in the order of the picks, with the scores they had.
 * They need their vectors: a retriever gives them with `includeVectors: true`.
 */
export class MaximalMarginalRelevance implements Postprocessor {
  readonly #model: EmbeddingModel;
  readonly #lambda: number;
  readonly #topK: number;

  constructor(options: {
    /** The model that made the vectors of the passages; it embeds the query. */
    readonly model: EmbeddingModel;
    /** From 0 to 1: 1 is relevance only, 0 is diversity only. 0.5 when absent. */
    readonly lambda?: number;
    readonly topK: number;
  }) {
    this.#model = options.model;
    this.#lambda = options.lambda ?? 0.5;
    this.#topK = options.topK;
    if (!(this.#lambda >= 0 && this.#lambda <= 1)) {
      throw new RangeError(`The lambda is from 0 to 1, not ${this.#lambda}`);
    }
    if (!Number.isInteger(this.#topK) || this.#topK < 1) {
      throw new RangeError(`The topK is a positive integer, not ${this.#topK}`);
    }
  }

  async postprocess(
    passages: readonly ScoredPassage[],
    query: string,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<ScoredPassage[]> {
    const candidates = passages.map((scored) => {
      if (scored.vector === undefined) {
        throw new VectorMissingError(scored.passage.id);
      }
      return { scored, vector: Vector.from(scored.vector) };
    });
    if (candidates.length === 0) return [];
    const { embedding } = await embed({
      model: this.#model,
      value: query,
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
    });
    const queryVector = Vector.from(embedding);
    const remaining = candidates.map(({ scored, vector }) => ({
      scored,
      vector,
      relevance: cosineSimilarity(vector, queryVector),
      redundancy: Number.NEGATIVE_INFINITY,
    }));
    const picked: typeof remaining = [];
    while (picked.length < this.#topK && remaining.length > 0) {
      const last = picked.at(-1);
      const value = (candidate: (typeof remaining)[number]): number =>
        last === undefined
          ? candidate.relevance
          : this.#lambda * candidate.relevance -
            (1 - this.#lambda) * candidate.redundancy;
      if (last !== undefined) {
        for (const candidate of remaining) {
          candidate.redundancy = Math.max(
            candidate.redundancy,
            cosineSimilarity(candidate.vector, last.vector),
          );
        }
      }
      const best = remaining.reduce((first, next) =>
        value(next) > value(first) ? next : first,
      );
      picked.push(best);
      remaining.splice(remaining.indexOf(best), 1);
    }
    return picked.map(({ scored }) => scored);
  }
}
