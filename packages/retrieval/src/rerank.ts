import { type RerankingModel, rerank } from 'ai';

import { finiteScore } from './finite-score.ts';
import type { Passage } from './passage.ts';
import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Reranks the passages with a reranking model through the AI SDK's `rerank`
 * (ADR 0008). The model gets the text of each passage and `topN`; without
 * `topN` it ranks every passage. Each passage that the model ranks gets the
 * relevance that the model gives it as its score, higher is better, best
 * first; a passage that the model leaves out is dropped, and so is one whose
 * relevance is under the `scoreThreshold` (ADR 0019). A relevance that is
 * not finite is a `TypeError` (`finiteScore`): the AI SDK passes the model's
 * `relevanceScore` on unchecked. An empty list makes no model call, as the AI
 * SDK's `rerank` sends none.
 */
export class Rerank implements Postprocessor<Passage> {
  readonly #model: RerankingModel;
  readonly #topN: number | undefined;
  readonly #scoreThreshold: number | undefined;

  constructor(options: {
    readonly model: RerankingModel;
    /** How many passages the model keeps: every passage when absent. */
    readonly topN?: number;
    /** The least score from the reranking model that a passage keeps: every passage when absent (ADR 0019). */
    readonly scoreThreshold?: number;
  }) {
    const { scoreThreshold } = options;
    if (scoreThreshold !== undefined && !Number.isFinite(scoreThreshold)) {
      throw new RangeError(
        `The scoreThreshold is a finite number, not ${scoreThreshold}`,
      );
    }
    this.#model = options.model;
    this.#topN = options.topN;
    this.#scoreThreshold = scoreThreshold;
  }

  async postprocess<P extends Passage>(
    passages: readonly ScoredPassage<P>[],
    query: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ScoredPassage<P>[]> {
    options.signal?.throwIfAborted();
    const { ranking } = await rerank({
      model: this.#model,
      documents: passages.map(({ passage }) => passage.text),
      query,
      ...(this.#topN === undefined ? {} : { topN: this.#topN }),
      // The AI SDK names the signal `abortSignal`.
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    const relevance = new Map(
      ranking.map(({ originalIndex, score }) => [originalIndex, score]),
    );
    return passages
      .flatMap(({ passage, vector }, index) => {
        const relevant = relevance.get(index);
        if (relevant === undefined) return [];
        const score = finiteScore('Rerank', passage, relevant);
        return [
          vector === undefined
            ? { passage, score }
            : { passage, score, vector },
        ];
      })
      .filter(
        ({ score }) =>
          this.#scoreThreshold === undefined || score >= this.#scoreThreshold,
      )
      .toSorted((a, b) => b.score - a.score);
  }
}
