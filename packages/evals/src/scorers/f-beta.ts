import {
  CountsForm,
  type FMeasureForm,
} from '../aggregation/f-measure-form.ts';
import { FMeasureRatio } from '../aggregation/f-measure-ratio.ts';
import type { Ratio } from '../aggregation/ratio.ts';
import type { Matches } from './matches.ts';
import type { Scorer } from './scorer.ts';

// The F-beta of the hits, as scikit-learn's fbeta_score: β weighs recall β
// times as much as precision. The form is the arithmetic of the value, and
// CountsForm is the form of scikit-learn.
export class FBeta<Input> implements Scorer<Input> {
  readonly #matches: Matches<Input>;
  readonly #beta: number;
  readonly #form: FMeasureForm;

  constructor(
    matches: Matches<Input>,
    {
      beta,
      form = new CountsForm(),
    }: { readonly beta: number; readonly form?: FMeasureForm },
  ) {
    this.#matches = matches;
    this.#beta = beta;
    this.#form = form;
  }

  score(input: Input): Ratio {
    return new FMeasureRatio(this.#matches.counts(input), {
      beta: this.#beta,
      form: this.#form,
    });
  }
}
