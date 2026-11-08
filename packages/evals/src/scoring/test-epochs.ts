import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import { Ratio } from '../aggregation/ratio.ts';
import type { Scorecard } from './scorecard.ts';

// The epochs of one test of a run, with the weight of its case.
export class TestEpochs {
  readonly weight: number;
  readonly #scorecards: Scorecard[] = [];

  constructor(weight: number) {
    this.weight = weight;
  }

  add(scorecard: Scorecard): void {
    this.#scorecards.push(scorecard);
  }

  gives(name: string): boolean {
    return this.#scorecards.some((scorecard) => scorecard.ratios.has(name));
  }

  // The mean of the epochs: Ratio(sum of the parts / k, sum of the wholes / k)
  // for k epochs (Miller 2024, §3.1). A scorecard without the name counts as
  // Ratio(0, 0), as in Totals.
  mean(name: string): Ratio {
    const sum = RatioOfSums.of(
      this.#scorecards.map(
        (scorecard) => scorecard.ratios.get(name) ?? new Ratio(0, 0),
      ),
    ).ratio;
    const k = this.#scorecards.length;
    return new Ratio(sum.part / k, sum.whole / k);
  }
}
