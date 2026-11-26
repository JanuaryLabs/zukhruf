/**
 * How many passages a composite asks of its retriever before it fuses,
 * reranks or diversifies them and cuts the list to the topK of the call, as
 * Elasticsearch's compound retrievers take `rank_window_size` (ADR 0007, ADR
 * 0023). A Value Object (Evans): it is made once from the `rankWindowSize`
 * option, so a size that is not a positive integer is a `RangeError` when the
 * composite is made. Without the option, the window is the topK of each call,
 * so a composite without it asks for what the call asks.
 */
export class RankWindow {
  readonly #size: number | undefined;

  private constructor(size: number | undefined) {
    this.#size = size;
  }

  /** The window of a `rankWindowSize` option: the topK of each call when absent. */
  static of(rankWindowSize: number | undefined): RankWindow {
    if (
      rankWindowSize !== undefined &&
      !(Number.isInteger(rankWindowSize) && rankWindowSize >= 1)
    ) {
      throw new RangeError(
        `The rankWindowSize is a positive integer, not ${rankWindowSize}`,
      );
    }
    return new RankWindow(rankWindowSize);
  }

  /**
   * The topK of a call, 10 when absent (ADR 0006), and the window for it. A
   * topK that is not a whole number of 0 or more is a `RangeError`, as
   * Elasticsearch refuses a bad `size`, and a topK of 0 gives no passages, as
   * `size` 0 does. A window smaller than that topK is a `RangeError`, as
   * Elasticsearch refuses a `rank_window_size` smaller than `size`.
   */
  forCall(topK = 10): { readonly topK: number; readonly window: number } {
    if (!(Number.isInteger(topK) && topK >= 0)) {
      throw new RangeError(
        `The topK is a whole number of 0 or more, not ${topK}`,
      );
    }
    const window = this.#size ?? topK;
    if (window < topK) {
      throw new RangeError(
        `The rankWindowSize ${window} is smaller than the topK ${topK} of the call`,
      );
    }
    return { topK, window };
  }
}
