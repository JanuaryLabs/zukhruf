import { type JsonData, NeumaierSum } from '@zukhruf/python';

import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// The mean of one value for each leaf of a pair, such as the share of the
// expected leaves that the stated value has with an equal value, and a fixed
// value when there is no leaf. The sum is CPython's, so a mean of floats is
// that of evaluate.py, and a sum of 0s and 1s is the exact count. A subclass
// says which leaves count and what one leaf gives, and its caller gives the
// value without leaves (Template Method).
export abstract class LeafMean implements Metric {
  readonly #whenNone: number;

  constructor(whenNone: number) {
    this.#whenNone = whenNone;
  }

  protected abstract leaves(pair: JsonPair): ReadonlyMap<string, JsonData>;

  protected abstract leafValue(
    path: string,
    value: JsonData,
    pair: JsonPair,
  ): number;

  of(pair: JsonPair): number {
    const leaves = this.leaves(pair);
    if (leaves.size === 0) return this.#whenNone;
    const sum = new NeumaierSum();
    for (const [path, value] of leaves)
      sum.add(this.leafValue(path, value, pair));
    return sum.value / leaves.size;
  }
}
