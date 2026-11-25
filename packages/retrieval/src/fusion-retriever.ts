import type { Fusion } from './fusion.ts';
import type { Passage } from './passage.ts';
import type { QueryType } from './query-bundle.ts';
import { reciprocalRankFusion } from './reciprocal-rank-fusion.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';

/**
 * Asks each retriever for `rankWindowSize` passages, fuses the lists on
 * `Passage.id` and gives the best `topK` (ADR 0007). Each retriever gets the
 * query unchanged and reads its own text, as LlamaIndex's
 * `QueryFusionRetriever` gives each retriever the same `QueryBundle`. So the
 * query type of the fusion is one that each retriever takes: TypeScript
 * infers the narrowest query type of the retrievers, and retrievers that
 * need two other fields take `new FusionRetriever<A & B>(…)` (ADR 0013). Its
 * passage type is one that each retriever gives: a fusion of engines gives
 * `StoredPassage`, and a fusion with a live source `Passage` (ADR 0015).
 */
export class FusionRetriever<
  in Q extends QueryType = QueryType,
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
> implements Retriever<Q, P> {
  readonly #retrievers: readonly Retriever<Q, P>[];
  readonly #fusion: Fusion<P>;
  readonly #weights: readonly number[];
  readonly #rankWindowSize: number | undefined;

  constructor(options: {
    readonly retrievers: readonly Retriever<Q, P>[];
    // `NoInfer`: P comes from the retrievers only. A fusion of the package
    // is generic in its `fuse`, so it takes P from there (ADR 0015).
    /** `reciprocalRankFusion()` when absent: k 60, ranks from 1. */
    readonly fusion?: Fusion<NoInfer<P>>;
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
    query: Q,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P>> {
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
    return {
      passages: this.#fusion
        .fuse(
          lists.map(({ passages }) => passages),
          this.#weights,
        )
        .slice(0, topK),
      failures: new Map(),
    };
  }
}
