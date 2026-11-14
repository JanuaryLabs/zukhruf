import type { Differentiable, Trainable } from './differentiable.ts';
import type { Matrix } from './matrix.ts';
import { Parameter } from './parameter.ts';

// The bilinear score of a state x and an option o with a weight of low rank,
// xᵀ leftᵀ right o = (left · x) · (right · o), of each state with each row of
// one options matrix that all the states share: the forward of BilinearHead
// of Venn (venn/heads/outcome.py) without its bias.
export class LowRankBilinear {
  // rank × state width, the weight of nn.Linear(states, rank, bias=False).
  readonly left: Parameter;
  // rank × option width.
  readonly right: Parameter;

  constructor(left: Matrix, right: Matrix) {
    if (left.rows !== right.rows)
      throw new RangeError(
        `The left factor has rank ${left.rows}, but the right factor has rank ${right.rows}.`,
      );
    this.left = new Parameter(left);
    this.right = new Parameter(right);
  }

  // One row for each state, one column for each option. The options are
  // data, so the pullback gives the gradient of the states only.
  forward(
    states: Matrix,
    options: Matrix,
  ): Differentiable<Matrix, Matrix> & Trainable<Matrix> {
    const left = states.timesTransposed(this.left.value);
    const right = options.timesTransposed(this.right.value);
    return {
      output: left.timesTransposed(right),
      pullback: (gradient) => gradient.times(right).times(this.left.value),
      accumulate: (gradient) => {
        this.left.accumulate(gradient.times(right).transposedTimes(states));
        this.right.accumulate(
          gradient.transposedTimes(left).transposedTimes(options),
        );
      },
    };
  }
}
