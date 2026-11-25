import type { ListScores } from './list-scores.ts';

/**
 * Gives one score of a list its new value from the list's statistics, as
 * Elasticsearch's `ScoreNormalizer` rescales each list of a linear fusion.
 */
export interface ScoreNormalizer {
  readonly normalize: (score: number, list: ListScores) => number;
}

/**
 * Gives a place of a list its score, as OpenSearch's `rrf` normalization
 * technique and Vespa's `reciprocal_rank` do.
 */
export interface RankNormalizer {
  /** `rank` counts from 1; `length` is the number of docs of the list. */
  readonly normalize: (rank: number, length: number) => number;
}

/**
 * Min-max scaling: the best score of a list becomes 1 and the worst 0
 * (Elasticsearch `minmax`, OpenSearch `min_max`, Weaviate
 * `relativeScoreFusion`). A list whose scores are all equal gives each doc 1,
 * as Elasticsearch, OpenSearch and Weaviate give it (ADR 0007, amendment
 * 2026-11-23).
 */
export function minMax(): ScoreNormalizer {
  return {
    normalize: (score, { min, max }) =>
      max === min ? 1 : (score - min) / (max - min),
  };
}

/**
 * Distribution-based scaling: mean - 3σ becomes 0 and mean + 3σ becomes 1,
 * with the population σ, and a score beyond either is not clipped (Qdrant
 * `dbsf`, LlamaIndex `dist_based_score`). A list with σ 0 gives each doc 0.5,
 * as Qdrant gives it (ADR 0007, amendment 2026-11-23).
 */
export function distributionBased(): ScoreNormalizer {
  return {
    normalize: (score, { mean, std }) => {
      const lowest = mean - 3 * std;
      const highest = mean + 3 * std;
      return std === 0 ? 0.5 : (score - lowest) / (highest - lowest);
    },
  };
}

/** The score as it is (Elasticsearch and MongoDB `none`). */
export function none(): ScoreNormalizer {
  return { normalize: (score) => score };
}

/**
 * `1 / (k + rank)`, with ranks from 1 (Cormack, Clarke and Büttcher, SIGIR
 * 2009; Vespa `reciprocal_rank(x, k)`). `k` is an integer of 1 or more, as
 * Elasticsearch's `rank_constant` is (ADR 0007, amendment 2026-11-25).
 */
export function reciprocalRank({
  k = 60,
}: { readonly k?: number } = {}): RankNormalizer {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(
      `The k of reciprocal rank fusion is an integer of 1 or more, not ${k}`,
    );
  }
  return { normalize: (rank) => 1 / (k + rank) };
}
