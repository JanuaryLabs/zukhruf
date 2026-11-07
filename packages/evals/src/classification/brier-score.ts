import { mean, sum } from '@zukhruf/statistics';

import { Ratio } from '../aggregation/ratio.ts';
import type { Scorer } from '../scorers/scorer.ts';
import { type BrierForm, TwoColumnForm } from './brier-form.ts';
import { type Label, compareLabels } from './label.ts';
import type { ProbabilityComparison } from './probability-comparison.ts';

// scikit-learn 1.9.1's brier_score_loss. For one answer, the sum over the
// classes of (1 when the class is the expected label, else 0, minus the
// stated probability) squared, with numpy's pairwise sum over the classes in
// their sorted order; times 0.5 for two classes. With a positive label, the
// answer gives the probability p of that label only, and the two classes are
// 1 - p and p, as scikit-learn reads a one-dimensional y_proba; the form
// (TwoColumnForm by default) gives the score of p. Its ratio is the score
// over 1, and mean gives the score of a whole run.
export class BrierScore implements Scorer<ProbabilityComparison> {
  readonly #positiveLabel: Label | undefined;
  readonly #form: BrierForm;

  constructor({
    positiveLabel,
    form = new TwoColumnForm(),
  }:
    | { readonly positiveLabel?: undefined; readonly form?: undefined }
    | { readonly positiveLabel: Label; readonly form?: BrierForm } = {}) {
    this.#positiveLabel = positiveLabel;
    this.#form = form;
  }

  score(comparison: ProbabilityComparison): Ratio {
    return new Ratio(this.#value(comparison), 1);
  }

  // The mean of the scores of the answers, with numpy's pairwise sum, each
  // answer with its weight (1 when none is given).
  mean(
    comparisons: readonly ProbabilityComparison[],
    weights?: readonly number[],
  ): number {
    const scores = comparisons.map((comparison) => this.#value(comparison));
    if (weights === undefined) return mean(scores);
    if (weights.length !== scores.length)
      throw new RangeError(
        `The answers and the weights have ${scores.length} and ${weights.length} values.`,
      );
    const weighted = scores.map(
      (score, index) => score * (weights[index] ?? 0),
    );
    return sum(weighted) / sum(weights);
  }

  #value({ probabilities, expected }: ProbabilityComparison): number {
    if (this.#positiveLabel !== undefined) {
      const p = probabilities.get(this.#positiveLabel);
      if (p === undefined)
        throw new RangeError(
          `The answer gives no probability of the positive label ${JSON.stringify(this.#positiveLabel)}.`,
        );
      return this.#form.of(p, expected === this.#positiveLabel ? 1 : 0);
    }
    if (!probabilities.has(expected))
      throw new RangeError(
        `The answer gives no probability of the expected label ${JSON.stringify(expected)}.`,
      );
    const squares = [...probabilities]
      .toSorted(([left], [right]) => compareLabels(left, right))
      .map(([label, probability]) => {
        const difference = (label === expected ? 1 : 0) - probability;
        return difference * difference;
      });
    const total = sum(squares);
    return squares.length < 3 ? 0.5 * total : total;
  }
}
