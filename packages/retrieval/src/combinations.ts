/**
 * Gives an id its fused score from the contributions of the inputs that hold
 * it, as MongoDB's `combination` and OpenSearch's
 * `ScoreCombinationTechnique.combine` do.
 */
export interface Combination {
  /** The contributions of the inputs that hold one id, in input order, weights included (0 too). */
  readonly combine: (
    contributions: readonly {
      readonly score: number;
      readonly weight: number;
    }[],
  ) => number;
}

/** `Σ w·s`, from 0, in input order (CombSUM; Milvus and Qdrant `sum`). */
export function sum(): Combination {
  return {
    combine: (contributions) =>
      contributions.reduce(
        (total, { score, weight }) => total + weight * score,
        0,
      ),
  };
}

/**
 * The greatest `w·s` (CombMAX; Milvus `max`), so a weight of 0 gives 0 (#5585).
 */
export function max(): Combination {
  return {
    combine: (contributions) =>
      Math.max(...contributions.map(({ score, weight }) => weight * score)),
  };
}

/**
 * `Σ w·s / Σ w` over the inputs that hold the id, and 0 when `Σ w` is 0, as
 * OpenSearch's `arithmetic_mean` gives it.
 */
export function arithmeticMean(): Combination {
  return {
    combine: (contributions) => {
      const weights = contributions.reduce(
        (total, { weight }) => total + weight,
        0,
      );
      const weighted = contributions.reduce(
        (total, { score, weight }) => total + weight * score,
        0,
      );
      return weights === 0 ? 0 : weighted / weights;
    },
  };
}
