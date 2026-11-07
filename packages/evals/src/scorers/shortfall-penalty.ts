import { Penalty } from './penalty.ts';
import type { Scorer } from './scorer.ts';

// The penalty min(1, (value / target) ** power) of the value of a scorer: 1
// when the value reaches the target, and below it the fraction of the target
// to the power. SOB gives image and audio records the factor of the key F1
// with the target 0.90 and the power 2 (compute_coverage_gate,
// sob-bench/evaluate.py:615-618), with the same arithmetic.
export class ShortfallPenalty<Input> extends Penalty<Input> {
  readonly #scorer: Scorer<Input>;
  readonly #target: number;
  readonly #power: number;

  constructor(
    scorer: Scorer<Input>,
    { target, power }: { readonly target: number; readonly power: number },
  ) {
    super();
    if (!(target > 0))
      throw new RangeError(`The target ${target} is not more than 0.`);
    if (!(power > 0))
      throw new RangeError(`The power ${power} is not more than 0.`);
    this.#scorer = scorer;
    this.#target = target;
    this.#power = power;
  }

  factor(input: Input): number {
    return Math.min(
      1,
      (this.#scorer.score(input).value / this.#target) ** this.#power,
    );
  }
}
