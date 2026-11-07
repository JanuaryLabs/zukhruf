import { Ratio } from '../aggregation/ratio.ts';
import type { Matches } from './matches.ts';
import type { Scorer } from './scorer.ts';

// The hits of the stated values: Ratio(hits, stated).
export class Precision<Input> implements Scorer<Input> {
  readonly #matches: Matches<Input>;

  constructor(matches: Matches<Input>) {
    this.#matches = matches;
  }

  score(input: Input): Ratio {
    const { hits, stated } = this.#matches.counts(input);
    return new Ratio(hits, stated);
  }
}
