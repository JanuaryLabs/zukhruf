import { mean, std } from '@zukhruf/statistics';

import { scoresOf, sumOnId } from './sum-on-id.ts';

/**
 * Distribution-based score fusion: each list's scores are scaled from
 * mean - 3σ (0) to mean + 3σ (1), with the population standard deviation,
 * and not clipped; then the weighted scaled scores of a passage are added
 * (Qdrant `dbsf`, LlamaIndex `dist_based_score`). A list with σ 0 gives each
 * passage 0.5, as Qdrant gives it (ADR 0007, amendment 2026-11-23). A
 * passage without a score is a `TypeError` that says to fuse a list of order
 * only with `reciprocalRankFusion` (ADR 0016).
 */
export function distributionBasedScoreFusion() {
  return sumOnId((list, index) => {
    const scores = scoresOf('distributionBasedScoreFusion', list, index);
    const average = mean(scores);
    const deviation = std(scores);
    const lowest = average - 3 * deviation;
    const highest = average + 3 * deviation;
    return scores.map((score) =>
      deviation === 0 ? 0.5 : (score - lowest) / (highest - lowest),
    );
  });
}
