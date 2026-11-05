import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import { Ratio } from '../aggregation/ratio.ts';
import type { Scorecard } from './scorecard.ts';

// A random generator that draws an index below a stop, such as the
// Random(seed) of python-random, which draws as CPython's random.Random does.
export type RandomIndex = { randrange(stop: number): number };

export type WeightedScorecard = {
  readonly scorecard: Scorecard;
  readonly weight: number;
};

// The 95% bootstrap interval of the mean of one name over many scorecards:
// each sample draws as many scorecards as there are, with replacement, and
// gives the ratio of sums of the name, each scorecard with its weight. The
// generator is an input and keeps its state between calls, so the order of
// the calls is the order of the draws.
export class Bootstrap {
  readonly #random: RandomIndex;
  readonly #samples: number;

  constructor(random: RandomIndex, samples: number) {
    this.#random = random;
    this.#samples = samples;
  }

  interval(
    rows: readonly WeightedScorecard[],
    name: string,
  ): readonly [number, number] {
    if (rows.length === 0) return [0, 0];
    const estimates: number[] = [];
    for (let draw = 0; draw < this.#samples; draw++) {
      const sum = new RatioOfSums();
      for (let pick = 0; pick < rows.length; pick++) {
        const row = rows[this.#random.randrange(rows.length)];
        const ratio = row?.scorecard.ratios.get(name);
        if (row === undefined || ratio === undefined)
          throw new Error(`No scorecard ratio named "${name}"`);
        sum.add(new Ratio(ratio.value, 1).times(row.weight));
      }
      estimates.push(sum.value);
    }
    return Bootstrap.#percentileBounds(estimates.toSorted((a, b) => a - b));
  }

  // percentile_bounds of SOB's evaluate.py: the estimates at floor(0.025·(n−1))
  // and ceil(0.975·(n−1)) of the sorted estimates.
  static #percentileBounds(
    values: readonly number[],
  ): readonly [number, number] {
    const at = (index: number) => {
      const value = values[index];
      if (value === undefined) throw new RangeError(`No estimate at ${index}`);
      return value;
    };
    return [
      at(Math.max(0, Math.floor(0.025 * (values.length - 1)))),
      at(Math.min(values.length - 1, Math.ceil(0.975 * (values.length - 1)))),
    ];
  }
}
