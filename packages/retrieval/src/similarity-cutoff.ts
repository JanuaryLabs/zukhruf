import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Keeps the passages whose score is at least the threshold, in their order,
 * as LlamaIndex's `SimilarityPostprocessor` drops a node whose score is below
 * its `similarity_cutoff` (ADR 0005, ADR 0008).
 */
export class SimilarityCutoff implements Postprocessor {
  readonly #threshold: number;

  constructor(options: { readonly threshold: number }) {
    this.#threshold = options.threshold;
  }

  async postprocess(
    passages: readonly ScoredPassage[],
  ): Promise<ScoredPassage[]> {
    return passages.filter(({ score }) => score >= this.#threshold);
  }
}
