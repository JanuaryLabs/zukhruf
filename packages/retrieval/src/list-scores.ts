import { mean, std } from '@zukhruf/statistics';

/**
 * The statistics of one list's scores, for a score normalizer. Each is
 * computed on its first read, over the scores in the order of the list.
 */
export interface ListScores {
  readonly min: number;
  readonly max: number;
  /** The mean of `@zukhruf/statistics`. */
  readonly mean: number;
  /** The population standard deviation (ddof 0) of `@zukhruf/statistics`. */
  readonly std: number;
  /** `sqrt(Σ s²)`, as Elasticsearch's `l2_norm`. */
  readonly l2: number;
}

/** The `ListScores` of a list's scores, each read computed once. */
export class ScoresOfList implements ListScores {
  readonly #scores: readonly number[];
  #min?: number;
  #max?: number;
  #mean?: number;
  #std?: number;
  #l2?: number;

  constructor(scores: readonly number[]) {
    this.#scores = scores;
  }

  get min(): number {
    this.#min ??= this.#scores.reduce(
      (lowest, score) => Math.min(lowest, score),
      Number.POSITIVE_INFINITY,
    );
    return this.#min;
  }

  get max(): number {
    this.#max ??= this.#scores.reduce(
      (highest, score) => Math.max(highest, score),
      Number.NEGATIVE_INFINITY,
    );
    return this.#max;
  }

  get mean(): number {
    this.#mean ??= mean(this.#scores);
    return this.#mean;
  }

  get std(): number {
    this.#std ??= std(this.#scores);
    return this.#std;
  }

  get l2(): number {
    this.#l2 ??= Math.sqrt(
      this.#scores.reduce((total, score) => total + score * score, 0),
    );
    return this.#l2;
  }
}
