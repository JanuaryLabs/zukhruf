import { Gate } from './gate.ts';
import type { Scorer } from './scorer.ts';

// A gate: it holds when the value of the scorer reaches the threshold.
export class AtLeast<Input> extends Gate<Input> {
  readonly #scorer: Scorer<Input>;
  readonly #threshold: number;

  constructor(scorer: Scorer<Input>, threshold: number) {
    super();
    this.#scorer = scorer;
    this.#threshold = threshold;
  }

  holds(input: Input): boolean {
    return this.#scorer.score(input).value >= this.#threshold;
  }

  explain(input: Input): string {
    return `the value ${this.#scorer.score(input).value} is below the threshold ${this.#threshold}`;
  }
}
