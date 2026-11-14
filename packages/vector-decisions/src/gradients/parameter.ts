import { Matrix } from './matrix.ts';

// A matrix that training changes, and the gradient of the loss with respect
// to it, as nn.Parameter of PyTorch and its .grad. Each backward pass adds to
// the gradient, so a parameter that a forward pass uses twice gets the sum.
export class Parameter {
  readonly value: Matrix;
  readonly gradient: Matrix;

  constructor(value: Matrix) {
    this.value = value;
    this.gradient = new Matrix(value.rows, value.columns);
  }

  accumulate(gradient: Matrix): void {
    if (
      gradient.rows !== this.value.rows ||
      gradient.columns !== this.value.columns
    )
      throw new RangeError(
        `A ${gradient.rows} × ${gradient.columns} gradient does not fit a ${this.value.rows} × ${this.value.columns} parameter.`,
      );
    const sum = this.gradient.values;
    for (const [index, value] of gradient.values.entries())
      sum[index] = (sum[index] ?? 0) + value;
  }
}
