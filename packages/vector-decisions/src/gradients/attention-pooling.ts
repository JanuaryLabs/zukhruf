import type { Trainable } from './differentiable.ts';
import { Matrix } from './matrix.ts';
import { Parameter } from './parameter.ts';

// Attention pooling of the fields of each state, with its question as the
// query: the pool of FamilyScorer of Venn (venn/heads/family.py) before its
// F.normalize. The score of a field is field · (query · question), and the
// pooled state is the sum of the fields weighted by the softmax of the
// scores.
export class AttentionPooling {
  // field width × question width, the weight of nn.Linear(width, width,
  // bias=False).
  readonly query: Parameter;

  constructor(query: Matrix) {
    this.query = new Parameter(query);
  }

  // One matrix of fields × field width for each state, and one row of
  // questions for each state. The fields and the questions are data, so the
  // pass has no pullback.
  forward(fields: readonly Matrix[], questions: Matrix): Trainable<Matrix> {
    if (fields.length !== questions.rows)
      throw new RangeError(
        `The ${fields.length} states of fields have ${questions.rows} questions.`,
      );
    const queries = questions.timesTransposed(this.query.value);
    const pooled = fields.map((state, index) => ({
      state,
      weights: AttentionPooling.#softmax(
        state.timesTransposed(AttentionPooling.#rowOf(queries, index)).values,
      ),
    }));
    const output = new Matrix(fields.length, this.query.value.rows);
    for (const [index, { state, weights }] of pooled.entries())
      output
        .row(index)
        .set(new Matrix(1, state.rows, weights).times(state).values);
    return {
      output,
      accumulate: (gradient) => {
        const queriesGradient = new Matrix(queries.rows, queries.columns);
        for (const [index, { state, weights }] of pooled.entries()) {
          const weightsGradient = state.timesTransposed(
            AttentionPooling.#rowOf(gradient, index),
          ).values;
          // The pullback of the softmax: w ⊙ (∂w − w · ∂w).
          const weighted = weights.reduce(
            (sum, weight, field) =>
              sum + weight * (weightsGradient[field] ?? 0),
            0,
          );
          const scoresGradient = weights.map(
            (weight, field) =>
              weight * ((weightsGradient[field] ?? 0) - weighted),
          );
          queriesGradient
            .row(index)
            .set(new Matrix(1, state.rows, scoresGradient).times(state).values);
        }
        this.query.accumulate(queriesGradient.transposedTimes(questions));
      },
    };
  }

  static #rowOf(matrix: Matrix, index: number): Matrix {
    return new Matrix(1, matrix.columns, matrix.row(index));
  }

  static #softmax(scores: Float64Array): Float64Array {
    const max = scores.reduce((a, b) => Math.max(a, b), -Infinity);
    const exponentials = scores.map((score) => Math.exp(score - max));
    const sum = exponentials.reduce((total, value) => total + value, 0);
    return exponentials.map((value) => value / sum);
  }
}
