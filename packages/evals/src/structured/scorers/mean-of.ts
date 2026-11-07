import { NeumaierSum } from '@zukhruf/python';

import { Ratio } from '../../aggregation/ratio.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { Scorer } from './scorer.ts';

// The mean of the values of some scorers for one record, over 1, with
// CPython's sum, such as a category of a benchmark. It takes one scorer or
// more, because the mean of no value has no value.
export class MeanOf implements Scorer {
  readonly #scorers: readonly Scorer[];

  constructor(scorer: Scorer, ...scorers: readonly Scorer[]) {
    this.#scorers = [scorer, ...scorers];
  }

  score(comparison: Comparison): Ratio {
    return new Ratio(
      NeumaierSum.mean(
        this.#scorers.map((scorer) => scorer.score(comparison).value),
      ),
      1,
    );
  }
}
