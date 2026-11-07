import { Ratio } from '../aggregation/ratio.ts';
import type { Matches } from './matches.ts';
import type { Scorer } from './scorer.ts';

// The hits of the expected values: Ratio(hits, expected).
export class Recall<Input> implements Scorer<Input> {
  readonly #matches: Matches<Input>;

  constructor(matches: Matches<Input>) {
    this.#matches = matches;
  }

  score(input: Input): Ratio {
    const { hits, expected } = this.#matches.counts(input);
    return new Ratio(hits, expected);
  }
}
