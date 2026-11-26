/**
 * The least score that a passage keeps, on the scale of the object that
 * takes it: an embedding retriever and `EmbeddingRerankRetriever` with the
 * cosine similarity, `RerankRetriever` with the relevance of its model (ADR
 * 0019). A Value Object (Evans): it is made once from the option, so a
 * threshold that is not finite is a `RangeError` when the object that takes
 * it is made. Without the option it is a Special Case (Fowler) that gives the
 * list unchanged and compares no score, so a score that is not finite
 * reaches the next check, such as the `TypeError` of a `ScoreFusion`.
 */
export abstract class ScoreThreshold {
  /** The threshold of a `scoreThreshold` option: the list unchanged when absent. */
  static of(least: number | undefined): ScoreThreshold {
    if (least === undefined) return new NoThreshold();
    if (!Number.isFinite(least)) {
      throw new RangeError(
        `The scoreThreshold is a finite number, not ${least}`,
      );
    }
    return new LeastScore(least);
  }

  /** The passages that the threshold keeps, in their order. */
  abstract keep<I extends { readonly score: number }>(passages: I[]): I[];
}

/** A threshold: the passages whose score is equal to or more than the least. */
class LeastScore extends ScoreThreshold {
  readonly #least: number;

  constructor(least: number) {
    super();
    this.#least = least;
  }

  keep<I extends { readonly score: number }>(passages: I[]): I[] {
    return passages.filter(({ score }) => score >= this.#least);
  }
}

/** No threshold: the list unchanged. */
class NoThreshold extends ScoreThreshold {
  keep<I extends { readonly score: number }>(passages: I[]): I[] {
    return passages;
  }
}
