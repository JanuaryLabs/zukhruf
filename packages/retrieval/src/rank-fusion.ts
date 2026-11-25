import { type Combination, sum } from './combinations.ts';
import { fuseOnId } from './fuse.ts';
import type { Fusion, FusionInput, RankedDoc, ScoreDoc } from './fusion.ts';
import { type RankNormalizer, reciprocalRank } from './normalizers.ts';

/**
 * Fuses lists by their order only, as MongoDB's `$rankFusion` does: a rank
 * normalizer gives each place its score, and a combination adds up the
 * weighted scores of an id. It reads no score, so it fuses a list of order
 * only beside a scored one (ADR 0016). With no options it is reciprocal rank
 * fusion, `reciprocalRank({ k: 60 })` and `sum()`, as `$rankFusion` is.
 */
export class RankFusion implements Fusion<RankedDoc> {
  readonly #normalizer: RankNormalizer;
  readonly #combination: Combination;

  constructor({
    normalizer = reciprocalRank(),
    combination = sum(),
  }: {
    readonly normalizer?: RankNormalizer;
    readonly combination?: Combination;
  } = {}) {
    this.#normalizer = normalizer;
    this.#combination = combination;
  }

  fuse(inputs: readonly FusionInput<RankedDoc>[]): ScoreDoc[] {
    return fuseOnId(
      inputs,
      ({ docs }) =>
        (_doc, rank) =>
          this.#normalizer.normalize(rank, docs.length),
      this.#combination,
    );
  }
}
