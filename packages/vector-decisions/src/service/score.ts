import { Choice } from './choice.ts';
import type { ChoiceAnswer, ScoreAnswer } from './decision.ts';

// Which level of a scale: the answer of a Choice, and the mean score of the
// options, weighted by their probabilities (venn/server.py:1102-1112).
export class Score extends Choice {
  readonly #scores: readonly number[];

  // `scores` holds one score for each option, in order.
  constructor(
    threshold: number | undefined,
    temperature: number,
    scores: readonly number[],
  ) {
    super(threshold, temperature);
    this.#scores = scores;
  }

  protected override complete(
    answer: ChoiceAnswer,
    probabilities: Float64Array,
  ): ScoreAnswer {
    let mass = 0;
    let total = 0;
    for (const [index, probability] of probabilities
      .subarray(0, -1)
      .entries()) {
      mass += probability;
      total += probability * (this.#scores[index] ?? Number.NaN);
    }
    return {
      ...answer,
      expectedScore: mass === 0 ? null : total / mass,
      scoreConditionedOnNotNone: true,
    };
  }
}
