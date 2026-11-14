import { InvalidResponseDataError } from 'ai';

import type { Answer } from '../service/decision.ts';

// The probabilities of the outcomes of a question, from the answer of its
// Choice, divided by their sum (venn/decisions.py:181-190).
export class Distribution {
  readonly #probabilities: Readonly<Record<string, number>>;
  readonly #mass: number;

  constructor(answer: Answer | undefined, outcomes: readonly string[]) {
    if (answer === undefined || !('probabilities' in answer))
      throw new InvalidResponseDataError({
        data: answer,
        message: 'DecisionService gave no answer of a Choice.',
      });
    this.#probabilities = answer.probabilities;
    this.#mass = outcomes.reduce(
      (sum, outcome) => sum + this.#before(outcome),
      0,
    );
  }

  probability(outcome: string): number {
    return this.#before(outcome) / this.#mass;
  }

  // The probability of "none" before the division (venn/decisions.py:182).
  get none(): number {
    return this.#before('none');
  }

  #before(outcome: string): number {
    const probability = this.#probabilities[outcome];
    if (probability === undefined)
      throw new InvalidResponseDataError({
        data: this.#probabilities,
        message: `DecisionService gave no probability of ${outcome}.`,
      });
    return probability;
  }
}
