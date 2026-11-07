import { NeumaierSum } from '@zukhruf/python';

import { Ratio } from './ratio.ts';

// The sum of the parts of many ratios divided by the sum of their wholes.
// Each average of the package is one (ADR 0004): a micro average adds
// Ratio(right, expected), a mean adds Ratio(value, 1), and a weighted mean
// adds Ratio(value × weight, weight).
export class RatioOfSums {
  readonly #parts = new NeumaierSum();
  readonly #wholes = new NeumaierSum();

  // The ratio of sums of the ratios, in their order.
  static of(ratios: Iterable<Ratio>): RatioOfSums {
    const sum = new RatioOfSums();
    for (const ratio of ratios) sum.add(ratio);
    return sum;
  }

  add(ratio: Ratio): void {
    this.#parts.add(ratio.part);
    this.#wholes.add(ratio.whole);
  }

  get ratio(): Ratio {
    return new Ratio(this.#parts.value, this.#wholes.value);
  }

  get value(): number {
    return this.ratio.value;
  }
}
