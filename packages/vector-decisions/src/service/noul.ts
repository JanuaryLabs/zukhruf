import type { ChoiceAnswer, NoulAnswer } from './decision.ts';
import { OneStateKind } from './one-state-kind.ts';

// A yes or no question: is the state "none" of the options? The probability
// of "none" comes first, from the "none" logit against all option logits,
// and the options share the rest (venn/server.py:1098-1100, 1113-1114).
export class Noul extends OneStateKind<NoulAnswer> {
  protected probabilities(logits: Float64Array): Float64Array {
    const options = logits.subarray(0, -1);
    const none = Noul.#sigmoid(
      ((logits.at(-1) ?? Number.NaN) - Noul.#logSumExp(options)) /
        this.temperature,
    );
    const probabilities = new Float64Array(logits.length);
    probabilities.set(
      OneStateKind.softmax(options, this.temperature).map(
        (probability) => probability * (1 - none),
      ),
    );
    probabilities[options.length] = none;
    return probabilities;
  }

  protected complete(
    answer: ChoiceAnswer,
    probabilities: Float64Array,
  ): NoulAnswer {
    const none = probabilities.at(-1) ?? Number.NaN;
    return {
      ...answer,
      answer: none >= (this.threshold ?? 0.5) ? 'none' : 'in_scope',
    };
  }

  static #sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }

  static #logSumExp(values: Float64Array): number {
    const largest = Math.max(...values);
    return (
      largest +
      Math.log(
        values.reduce((sum, value) => sum + Math.exp(value - largest), 0),
      )
    );
  }
}
