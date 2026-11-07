import { F1Ratio } from '../aggregation/f1-ratio.ts';
import type { Matches } from './matches.ts';
import type { Scorer } from './scorer.ts';

// The F1 of the hits: an F1Ratio of the counts.
export class F1<Input> implements Scorer<Input> {
  readonly #matches: Matches<Input>;

  constructor(matches: Matches<Input>) {
    this.#matches = matches;
  }

  score(input: Input): F1Ratio {
    return new F1Ratio(this.#matches.counts(input));
  }
}
