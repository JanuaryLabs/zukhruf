import { Ratio } from '../aggregation/ratio.ts';
import type { Scorer } from './scorer.ts';

// The value of a scorer over 1, so a ratio of sums of many records is the
// mean of their values: scikit-learn's average='samples'. A record whose
// ratio has the whole 0 gives whenEmpty (Decorator).
export class SampleAveraged<Input> implements Scorer<Input> {
  readonly #scorer: Scorer<Input>;
  readonly #whenEmpty: number;

  constructor(
    scorer: Scorer<Input>,
    { whenEmpty }: { readonly whenEmpty: number },
  ) {
    this.#scorer = scorer;
    this.#whenEmpty = whenEmpty;
  }

  score(input: Input): Ratio {
    const ratio = this.#scorer.score(input);
    return new Ratio(ratio.whole === 0 ? this.#whenEmpty : ratio.value, 1);
  }
}
