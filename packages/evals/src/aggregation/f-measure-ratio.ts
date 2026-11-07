import type { Counts } from './counts.ts';
import type { FMeasureForm } from './f-measure-form.ts';
import { Ratio } from './ratio.ts';

// The ratio of an F-measure: its part is (1 + β²)·hits and its whole is
// β²·expected + stated, so many of them add up to the micro F-measure. Its
// value is the value of its form, which can differ from part / whole in the
// last bit (ADR 0003).
export class FMeasureRatio extends Ratio {
  readonly #counts: Counts;
  readonly #beta: number;
  readonly #form: FMeasureForm;

  constructor(
    counts: Counts,
    { beta, form }: { readonly beta: number; readonly form: FMeasureForm },
  ) {
    const beta2 = beta ** 2;
    super((1 + beta2) * counts.hits, beta2 * counts.expected + counts.stated);
    this.#counts = counts;
    this.#beta = beta;
    this.#form = form;
  }

  override get value(): number {
    return this.#form.of(this.#counts, this.#beta);
  }
}
