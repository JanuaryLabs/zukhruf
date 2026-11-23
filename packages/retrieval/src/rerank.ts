import { type RerankingModel, rerank } from 'ai';

import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Reranks the passages with a reranking model through the AI SDK's `rerank`
 * (ADR 0008). The model gets the text of each passage and `topN`; without
 * `topN` it ranks every passage. Each passage that the model ranks gets the
 * relevance that the model gives it as its score, higher is better, best
 * first; a passage that the model leaves out is dropped. An empty list makes
 * no model call, as the AI SDK's `rerank` sends none.
 */
export class Rerank implements Postprocessor {
  readonly #model: RerankingModel;
  readonly #topN: number | undefined;

  constructor(options: {
    readonly model: RerankingModel;
    /** How many passages the model keeps: every passage when absent. */
    readonly topN?: number;
  }) {
    this.#model = options.model;
    this.#topN = options.topN;
  }

  async postprocess(
    passages: readonly ScoredPassage[],
    query: string,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<ScoredPassage[]> {
    const { ranking } = await rerank({
      model: this.#model,
      documents: passages.map(({ passage }) => passage.text),
      query,
      ...(this.#topN === undefined ? {} : { topN: this.#topN }),
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
    });
    const relevance = new Map(
      ranking.map(({ originalIndex, score }) => [originalIndex, score]),
    );
    return passages
      .flatMap(({ passage, vector }, index) => {
        const score = relevance.get(index);
        if (score === undefined) return [];
        return [
          vector === undefined
            ? { passage, score }
            : { passage, score, vector },
        ];
      })
      .toSorted((a, b) => b.score - a.score);
  }
}
