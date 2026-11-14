import type { Differentiable, Trainable } from './differentiable.ts';
import { Matrix } from './matrix.ts';
import { Parameter } from './parameter.ts';

// nn.Linear of PyTorch: output = input · weightᵀ + bias.
export class Linear {
  // outputs × inputs, as nn.Linear stores it.
  readonly weight: Parameter;
  // 1 × outputs.
  readonly bias: Parameter;

  constructor(weight: Matrix, bias: Matrix) {
    if (bias.rows !== 1 || bias.columns !== weight.rows)
      throw new RangeError(
        `The bias of ${weight.rows} outputs is 1 × ${weight.rows}, not ${bias.rows} × ${bias.columns}.`,
      );
    this.weight = new Parameter(weight);
    this.bias = new Parameter(bias);
  }

  forward(input: Matrix): Differentiable<Matrix, Matrix> & Trainable<Matrix> {
    const weight = this.weight.value;
    const output = input.timesTransposed(weight);
    const bias = this.bias.value.values;
    for (let row = 0; row < output.rows; row++) {
      const values = output.row(row);
      for (const [column, value] of bias.entries())
        values[column] = (values[column] ?? 0) + value;
    }
    return {
      output,
      pullback: (gradient) => gradient.times(weight),
      accumulate: (gradient) => {
        this.weight.accumulate(gradient.transposedTimes(input));
        const ones = new Matrix(
          1,
          gradient.rows,
          new Float64Array(gradient.rows).fill(1),
        );
        this.bias.accumulate(ones.times(gradient));
      },
    };
  }
}
