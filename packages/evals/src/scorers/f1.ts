import type { FMeasureForm } from '../aggregation/f-measure-form.ts';
import { FBeta } from './f-beta.ts';
import type { Matches } from './matches.ts';

// The F1 of the hits: the F-beta with β = 1.
export class F1<Input> extends FBeta<Input> {
  constructor(
    matches: Matches<Input>,
    options: { readonly form?: FMeasureForm } = {},
  ) {
    super(matches, { ...options, beta: 1 });
  }
}
