import { NeumaierSum } from '@zukhruf/python';

import { Ratio } from '../aggregation/ratio.ts';
import type { Scorer } from './scorer.ts';

// The mean of the values of some scorers for one record, over 1, with
// CPython's sum, such as a category of a benchmark. It takes one scorer or
// more, because the mean of no value has no value.
export class MeanOf<Input> implements Scorer<Input> {
  readonly #scorers: readonly Scorer<Input>[];

  constructor(scorer: Scorer<Input>, ...scorers: readonly Scorer<Input>[]) {
    this.#scorers = [scorer, ...scorers];
  }

  score(input: Input): Ratio {
    return new Ratio(
      NeumaierSum.mean(
        this.#scorers.map((scorer) => scorer.score(input).value),
      ),
      1,
    );
  }
}
