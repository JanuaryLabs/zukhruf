import type { Passage } from './passage.ts';
import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Keeps the passages whose score is at least the threshold, in their order,
 * as LlamaIndex's `SimilarityPostprocessor` drops a node whose score is below
 * its `similarity_cutoff` (ADR 0005, ADR 0008). A passage without a score is
 * not kept, as LlamaIndex's `SimilarityPostprocessor` drops it (ADR 0016).
 */
export class SimilarityCutoff implements Postprocessor<Passage> {
  readonly #threshold: number;

  constructor(options: { readonly threshold: number }) {
    this.#threshold = options.threshold;
  }

  async postprocess<P extends Passage>(
    passages: readonly ScoredPassage<P>[],
    _query?: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ScoredPassage<P>[]> {
    options.signal?.throwIfAborted();
    return passages.filter(
      ({ score }) => score !== undefined && score >= this.#threshold,
    );
  }
}
