import { NeumaierSum } from '@zukhruf/python';

import type { JsonPair } from '../json-pair.ts';
import type { Scorer } from '../scorer.ts';

// The mean of some scorers for one record, with CPython's sum, such as a
// category of a benchmark.
export class MeanOf implements Scorer {
  readonly #scorers: readonly Scorer[];

  constructor(...scorers: readonly Scorer[]) {
    this.#scorers = scorers;
  }

  score(pair: JsonPair): number {
    const sum = new NeumaierSum();
    for (const scorer of this.#scorers) sum.add(scorer.score(pair));
    return sum.value / this.#scorers.length;
  }
}
