import type { Scores } from './scores.ts';
import { sum } from './statistics.ts';
import type { Threshold } from './threshold.ts';

// The plug-in rule that maximises the expected F-beta over the probabilities
// themselves. Accepting the m most probable articles has the expected F-beta
// (1 + beta²) * (sum of their probabilities) / (beta² * sum of all
// probabilities + m). With beta 0.5 it is the threshold of the frozen design
// (docs/adr/0002). When no article has a probability above 0, it accepts
// nothing.
export class ExpectedFThreshold implements Threshold {
  readonly #betaSquared: number;

  constructor(options: { readonly beta: number }) {
    this.#betaSquared = options.beta ** 2;
  }

  cut(scores: Scores): number {
    const order = scores
      .ranked()
      .map((id) => scores.probability(id))
      .toSorted((a, b) => b - a);
    const total = sum(order);
    let best: { value: number; threshold: number } | undefined;
    let cumulative = 0;
    for (const [index, probability] of order.entries()) {
      cumulative += probability;
      const value =
        ((1 + this.#betaSquared) * cumulative) /
        (this.#betaSquared * total + index + 1);
      if (best === undefined || value > best.value)
        best = { value, threshold: probability };
    }
    if (best === undefined || best.value <= 0) return Infinity;
    return best.threshold;
  }
}
