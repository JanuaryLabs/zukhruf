import type { ScoredPassage } from './scored-passage.ts';

/**
 * The part that the three fusions share: each list's scores become new
 * scores by the fusion's own rule, each new score is multiplied by the weight
 * of its list, and the products of one `Passage.id` are added, best first. A
 * passage that a list does not hold adds nothing from that list (ADR 0007,
 * amendment 2026-11-23).
 *
 * The passage is the one of the first list that holds the id, its vector the
 * first that a list gives, and equal fused scores keep the order in which
 * their ids first appear (`toSorted` is stable).
 */
export function sumOnId(
  lists: readonly (readonly ScoredPassage[])[],
  weights: readonly number[],
  rescale: (scores: readonly number[]) => readonly number[],
): ScoredPassage[] {
  if (weights.length !== lists.length) {
    throw new RangeError(
      `A fusion takes one weight for each list: got ${weights.length} weights for ${lists.length} lists`,
    );
  }
  const fused = new Map<string, Fused>();
  for (const [index, list] of lists.entries()) {
    const weight = weights[index] ?? 1;
    const scores = rescale(list.map(({ score }) => score));
    for (const [position, { passage, vector }] of list.entries()) {
      const score = weight * (scores[position] ?? 0);
      const entry = fused.get(passage.id);
      if (entry === undefined) {
        fused.set(passage.id, { passage, score, vector });
      } else {
        entry.score += score;
        entry.vector ??= vector;
      }
    }
  }
  return [...fused.values()]
    .map(({ passage, score, vector }) =>
      vector === undefined ? { passage, score } : { passage, score, vector },
    )
    .toSorted((a, b) => b.score - a.score);
}

type Fused = {
  readonly passage: ScoredPassage['passage'];
  score: number;
  vector: ScoredPassage['vector'];
};
