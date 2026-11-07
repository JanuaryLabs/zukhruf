import { NeumaierSum } from '@zukhruf/python';

import { Ratio } from '../aggregation/ratio.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { Scorer } from './scorer.ts';

// The mean of the values of some scorers for one record, over 1, with
// CPython's sum, such as a category of a benchmark.
export class MeanOf implements Scorer {
  readonly #scorers: readonly Scorer[];

  constructor(...scorers: readonly Scorer[]) {
    this.#scorers = scorers;
  }

  score(comparison: Comparison): Ratio {
    const sum = new NeumaierSum();
    for (const scorer of this.#scorers) sum.add(scorer.score(comparison).value);
    return new Ratio(sum.value / this.#scorers.length, 1);
  }
}
