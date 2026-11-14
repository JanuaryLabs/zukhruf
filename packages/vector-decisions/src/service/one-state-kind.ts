import type { PreparedQuestion } from '../head/prepared-question.ts';
import type { Answer, ChoiceAnswer } from './decision.ts';
import type { QuestionKind } from './question-kind.ts';

// The smallest norm that F.normalize of PyTorch divides by.
const NORM_EPSILON = 1e-12;

// A kind that answers one state: the steps that turn the logits of the unit
// vector of the state into its answer. A kind gives the probabilities and
// completes the answer. The steps between are Venn's DecisionService.answer
// (venn/server.py:1129): the first label of the largest probability, or
// "none" when the confidence is below the threshold.
export abstract class OneStateKind<
  A extends Answer = Answer,
> implements QuestionKind {
  protected readonly threshold: number | undefined;
  protected readonly temperature: number;
  readonly #state: Float32Array;

  constructor(
    threshold: number | undefined,
    temperature: number,
    state: Float32Array,
  ) {
    this.threshold = threshold;
    this.temperature = temperature;
    this.#state = state;
  }

  answer(prepared: PreparedQuestion, labels: readonly string[]): A {
    const [logits = new Float64Array()] = prepared.logits([
      OneStateKind.#unit(this.#state),
    ]);
    const probabilities = this.probabilities(logits);
    const names = [...labels, 'none'];
    let best = 0;
    for (const [index, probability] of probabilities.entries())
      if (probability > (probabilities[best] ?? 0)) best = index;
    const confidence = probabilities[best] ?? Number.NaN;
    const belowThreshold =
      this.threshold !== undefined && confidence < this.threshold;
    return this.complete(
      {
        answer: belowThreshold ? 'none' : (names[best] ?? 'none'),
        probabilities: Object.fromEntries(
          names.map((name, index) => [
            name,
            probabilities[index] ?? Number.NaN,
          ]),
        ),
        confidence,
        calibrated: false,
      },
      probabilities,
    );
  }

  // `logits` holds the logit of each label, then of "none".
  protected abstract probabilities(logits: Float64Array): Float64Array;

  protected abstract complete(
    answer: ChoiceAnswer,
    probabilities: Float64Array,
  ): A;

  // The softmax of the values divided by the temperature.
  protected static softmax(
    values: Float64Array,
    temperature: number,
  ): Float64Array {
    const scaled = values.map((value) => value / temperature);
    const largest = Math.max(...scaled);
    const exponentials = scaled.map((value) => Math.exp(value - largest));
    const sum = exponentials.reduce((total, value) => total + value, 0);
    return exponentials.map((value) => value / sum);
  }

  // The vector divided by its norm in float32, as F.normalize of PyTorch
  // makes the state a unit vector before the logits (venn/server.py:1095,
  // venn/index/apply.py:63).
  static #unit(vector: Float32Array): Float32Array {
    const norm = Math.max(Math.fround(Math.hypot(...vector)), NORM_EPSILON);
    return vector.map((value) => value / norm);
  }
}
