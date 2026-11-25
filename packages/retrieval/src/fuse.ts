import type { Combination } from './combinations.ts';
import type { FusionInput, RankedDoc, ScoreDoc } from './fusion.ts';

/**
 * The steps that `RankFusion` and `ScoreFusion` share. First the weights
 * (ADR 0007, amendment 2026-11-25): each a finite number of 0 or more, and at
 * least one above 0 when there is an input, as Haystack's `DocumentJoiner`,
 * Elasticsearch's rrf and linear retrievers and LangChain's
 * `EnsembleRetriever` require. Then `scorer` reads each input, so a family
 * can check what it reads before any doc is normalized, and gives the
 * normalized score of each doc by its rank from 1. Then the contributions of
 * one id, in input order, go to the combination once, and the fused list is
 * sorted best first; `toSorted` is stable, so equal scores keep the order in
 * which their ids first appear.
 */
export function fuseOnId<D extends RankedDoc>(
  inputs: readonly FusionInput<D>[],
  scorer: (input: FusionInput<D>) => (doc: D, rank: number) => number,
  combination: Combination,
): ScoreDoc[] {
  checkWeights(inputs);
  const scored = inputs.map((input) => ({ input, normalize: scorer(input) }));
  const fused = new Map<string, Contributions>();
  for (const { input, normalize } of scored) {
    for (const [index, doc] of input.docs.entries()) {
      const score = normalize(doc, index + 1);
      if (!Number.isFinite(score)) {
        throw new TypeError(
          `The normalizer gave ${doc.id} of ${input.name} the score ${score}: a normalized score is a finite number`,
        );
      }
      const entry = fused.get(doc.id) ?? { contributions: [], names: [] };
      entry.contributions.push({ score, weight: input.weight });
      entry.names.push(input.name);
      fused.set(doc.id, entry);
    }
  }
  return [...fused]
    .map(([id, { contributions, names }]) => {
      const score = combination.combine(contributions);
      if (!Number.isFinite(score)) {
        throw new TypeError(
          `The combination gave ${id} the score ${score}, from ${names.join(', ')}: a fused score is a finite number`,
        );
      }
      return { id, score };
    })
    .toSorted((a, b) => b.score - a.score);
}

type Contributions = {
  readonly contributions: { readonly score: number; readonly weight: number }[];
  readonly names: string[];
};

/**
 * The weight rule of every fusion, which `FusionRetriever` also applies when
 * it is made, with the names of its retrievers.
 */
export function checkWeights(
  inputs: readonly { readonly name: string; readonly weight: number }[],
): void {
  for (const { name, weight } of inputs) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(
        `The weight of ${name} is a finite number of 0 or more, not ${weight}`,
      );
    }
  }
  if (inputs.length > 0 && !inputs.some(({ weight }) => weight > 0)) {
    throw new RangeError(
      'A fusion takes at least one weight above 0: every weight is 0',
    );
  }
}
