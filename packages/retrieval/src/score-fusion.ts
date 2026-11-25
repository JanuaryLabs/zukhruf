import type { Combination } from './combinations.ts';
import { fuseOnId } from './fuse.ts';
import type { Fusion, FusionInput, ScoreDoc } from './fusion.ts';
import { ScoresOfList } from './list-scores.ts';
import type { ScoreNormalizer } from './normalizers.ts';

/**
 * Fuses lists by their scores, as MongoDB's `$scoreFusion` does: a score
 * normalizer rescales each list from its statistics, and a combination joins
 * the weighted scores of an id. Both are required, as the leaders split on
 * both defaults (MongoDB `avg`, Elasticsearch and Qdrant `sum`, OpenSearch
 * `arithmetic_mean`). A score that is not finite is a `TypeError` that names
 * the doc and its input, before any list is normalized (#5700): it would turn
 * the statistics of its whole list into NaN.
 */
export class ScoreFusion implements Fusion<ScoreDoc> {
  readonly #normalizer: ScoreNormalizer;
  readonly #combination: Combination;

  constructor({
    normalizer,
    combination,
  }: {
    readonly normalizer: ScoreNormalizer;
    readonly combination: Combination;
  }) {
    this.#normalizer = normalizer;
    this.#combination = combination;
  }

  fuse(inputs: readonly FusionInput<ScoreDoc>[]): ScoreDoc[] {
    return fuseOnId(
      inputs,
      ({ name, docs }) => {
        for (const { id, score } of docs) {
          if (!Number.isFinite(score)) {
            throw new TypeError(
              `ScoreFusion reads scores, and ${id} of ${name} has the score ${score}: a score is a finite number`,
            );
          }
        }
        const list = new ScoresOfList(docs.map(({ score }) => score));
        return ({ score }) => this.#normalizer.normalize(score, list);
      },
      this.#combination,
    );
  }
}
