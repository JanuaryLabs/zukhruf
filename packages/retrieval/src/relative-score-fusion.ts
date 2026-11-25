import { scoresOf, sumOnId } from './sum-on-id.ts';

/**
 * Min-max scaling: the best score of each list becomes 1 and the worst 0,
 * then the weighted scaled scores of a passage are added (Weaviate
 * `relativeScoreFusion`, LlamaIndex `relative_score`). A list whose scores
 * are all equal gives each passage 1, as Weaviate and OpenSearch give it
 * (ADR 0007, amendment 2026-11-23). A passage without a score is a
 * `TypeError` that says to fuse a list of order only with
 * `reciprocalRankFusion` (ADR 0016).
 */
export function relativeScoreFusion() {
  return sumOnId((list, index) => {
    const scores = scoresOf('relativeScoreFusion', list, index);
    const lowest = Math.min(...scores);
    const highest = Math.max(...scores);
    return scores.map((score) =>
      highest === lowest ? 1 : (score - lowest) / (highest - lowest),
    );
  });
}
