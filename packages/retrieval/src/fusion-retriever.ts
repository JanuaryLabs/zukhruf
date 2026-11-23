import type { Fusion } from './fusion.ts';
import { reciprocalRankFusion } from './reciprocal-rank-fusion.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Asks each retriever for `rankWindowSize` passages, fuses the lists on
 * `Passage.id` and gives the best `topK` (ADR 0007).
 */
export class FusionRetriever implements Retriever {
  readonly #retrievers: readonly Retriever[];
  readonly #fusion: Fusion;
  readonly #weights: readonly number[];
  readonly #rankWindowSize: number | undefined;

  constructor(options: {
    readonly retrievers: readonly Retriever[];
    /** `reciprocalRankFusion()` when absent: k 60, ranks from 1. */
    readonly fusion?: Fusion;
    /** One weight for each retriever, in their order: 1 each when absent. */
    readonly weights?: readonly number[];
    /**
     * How many passages each retriever gives to the fusion: the `topK` of
     * the call when absent. It is at least that `topK`, as Elasticsearch's
     * `rank_window_size` is at least `size`.
     */
    readonly rankWindowSize?: number;
  }) {
    this.#retrievers = options.retrievers;
    this.#fusion = options.fusion ?? reciprocalRankFusion();
    this.#weights = options.weights ?? options.retrievers.map(() => 1);
    this.#rankWindowSize = options.rankWindowSize;
    if (this.#weights.length !== this.#retrievers.length) {
      throw new RangeError(
        `A FusionRetriever takes one weight for each retriever: got ${this.#weights.length} weights for ${this.#retrievers.length} retrievers`,
      );
    }
  }

  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    const topK = options.topK ?? 10;
    const rankWindowSize = this.#rankWindowSize ?? topK;
    if (rankWindowSize < topK) {
      throw new RangeError(
        `The rankWindowSize ${rankWindowSize} is smaller than the topK ${topK} of the call`,
      );
    }
    const lists = await Promise.all(
      this.#retrievers.map((retriever) =>
        retriever.retrieve(query, { ...options, topK: rankWindowSize }),
      ),
    );
    return this.#fusion.fuse(lists, this.#weights).slice(0, topK);
  }
}
