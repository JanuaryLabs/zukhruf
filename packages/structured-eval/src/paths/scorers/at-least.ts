import type { JsonPair } from '../json-pair.ts';
import type { Scorer } from '../scorer.ts';
import { Gate } from './gate.ts';

// A gate: 1 when the scorer reaches the threshold, else 0.
export class AtLeast extends Gate {
  readonly #scorer: Scorer;
  readonly #threshold: number;

  constructor(scorer: Scorer, threshold: number) {
    super();
    this.#scorer = scorer;
    this.#threshold = threshold;
  }

  protected holds(pair: JsonPair): boolean {
    return this.#scorer.score(pair) >= this.#threshold;
  }
}
