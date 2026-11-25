import { finiteScore } from './finite-score.ts';
import type { Passage } from './passage.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Refuses the weights that would make a fused list wrong with no error: each
 * weight is a finite number of 0 or more, and when there is a list, at least
 * one weight is above 0, as Haystack's `DocumentJoiner`, Elasticsearch's rrf
 * and linear retrievers and LangChain's `EnsembleRetriever` require (ADR
 * 0007, amendment 2026-11-25). Each weight comes with the name of its list or
 * retriever, which the `RangeError` gives.
 */
export function checkWeights(
  weights: readonly (readonly [name: string, weight: number])[],
): void {
  for (const [name, weight] of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(
        `The weight of ${name} is a finite number of 0 or more, not ${weight}`,
      );
    }
  }
  if (weights.length > 0 && !weights.some(([, weight]) => weight > 0)) {
    throw new RangeError(
      'A fusion takes at least one weight above 0: every weight is 0',
    );
  }
}

/**
 * The part that the three fusions share: each list becomes new scores by the
 * fusion's own rule, each new score is multiplied by the weight of its list,
 * and the products of one `Passage.id` are added, best first. A
 * passage that a list does not hold adds nothing from that list (ADR 0007,
 * amendment 2026-11-23).
 *
 * The passage is the one of the first list that holds the id, its vector the
 * first that a list gives, and equal fused scores keep the order in which
 * their ids first appear (`toSorted` is stable).
 *
 * The rule gets each list and its index in `lists`: reciprocal rank fusion
 * reads its order only, and a score fusion reads its scores with `scoresOf`
 * (ADR 0016).
 *
 * Its `fuse` is generic: it only adds and orders the passages it gets, so it
 * serves a `Fusion<P>` of any passage type (ADR 0015).
 */
export function sumOnId(
  rescale: (list: readonly ScoredPassage[], index: number) => readonly number[],
): {
  readonly fuse: <P extends Passage>(
    lists: readonly (readonly ScoredPassage<P>[])[],
    weights: readonly number[],
  ) => ScoredPassage<P>[];
} {
  return { fuse: (lists, weights) => fuseOnId(lists, weights, rescale) };
}

function fuseOnId<P extends Passage>(
  lists: readonly (readonly ScoredPassage<P>[])[],
  weights: readonly number[],
  rescale: (list: readonly ScoredPassage[], index: number) => readonly number[],
): ScoredPassage<P>[] {
  if (weights.length !== lists.length) {
    throw new RangeError(
      `A fusion takes one weight for each list: got ${weights.length} weights for ${lists.length} lists`,
    );
  }
  checkWeights(weights.map((weight, index) => [`list ${index}`, weight]));
  const fused = new Map<string, Fused<P>>();
  for (const [index, list] of lists.entries()) {
    const weight = weights[index] ?? 1;
    const scores = rescale(list, index);
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

type Fused<P extends Passage> = {
  readonly passage: P;
  score: number;
  vector: ScoredPassage['vector'];
};

/**
 * The scores of a list, for a score fusion. A passage without a score is a
 * `TypeError` that names the fusion, the passage and the index of its list in
 * `lists`: a score fusion over a source of order only is a bug of its caller,
 * and reciprocal rank fusion fuses such a list (ADR 0016). Taking a missing
 * score as 0, as LlamaIndex, Haystack and Eino do, would tie each passage of
 * that list with the best scored passage. A score that is not finite is a
 * `TypeError` too (`finiteScore`).
 */
export function scoresOf(
  fusion: string,
  list: readonly ScoredPassage[],
  index: number,
): number[] {
  return list.map(({ passage, score }) => {
    if (score === undefined) {
      throw new TypeError(
        `${fusion} reads scores, and the passage ${passage.id} of list ${index} has none: fuse a list of order only with reciprocalRankFusion`,
      );
    }
    return finiteScore(fusion, passage, score, index);
  });
}
