import type { Comparison } from '../comparison/comparison.ts';
import { Gate } from './gate.ts';
import type { Scorer } from './scorer.ts';

// A gate: it holds when the value of the scorer reaches the threshold.
export class AtLeast extends Gate {
  readonly #scorer: Scorer;
  readonly #threshold: number;

  constructor(scorer: Scorer, threshold: number) {
    super();
    this.#scorer = scorer;
    this.#threshold = threshold;
  }

  holds(comparison: Comparison): boolean {
    return this.#scorer.score(comparison).value >= this.#threshold;
  }

  explain(comparison: Comparison): string {
    return `the value ${this.#scorer.score(comparison).value} is below the threshold ${this.#threshold}`;
  }
}
