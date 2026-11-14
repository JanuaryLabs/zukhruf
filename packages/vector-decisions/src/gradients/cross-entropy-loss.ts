import type { Differentiable } from './differentiable.ts';
import { Matrix } from './matrix.ts';

// The smallest sum of weights that the loss divides by, as fit_outcome_head
// of Venn clamps it (venn/heads/outcome.py), so that a batch whose weights are
// all 0 has the loss 0, not NaN.
const WEIGHT_FLOOR = 1e-9;

// The cross-entropy of the softmax of each row of logits with the target of
// the row, as F.cross_entropy of PyTorch computes it, and the mean of the rows
// weighted by the weight of each row: Σ wᵢ ℓᵢ / max(Σ wᵢ, 1e-9). Weights of 1
// give the mean of F.cross_entropy. A logit of -1e4, with which Venn masks an
// absent option (venn/heads/family.py), has the probability 0, so it adds
// nothing to the loss and gets the gradient 0.
export class CrossEntropyLoss {
  forward(
    logits: Matrix,
    targets: ArrayLike<number>,
    weights: ArrayLike<number>,
  ): Differentiable<number, Matrix> {
    if (targets.length !== logits.rows || weights.length !== logits.rows)
      throw new RangeError(
        `The ${logits.rows} rows of logits have ${targets.length} targets and ${weights.length} weights.`,
      );
    const logSoftmax = new Matrix(logits.rows, logits.columns);
    let total = 0;
    let weightSum = 0;
    for (let row = 0; row < logits.rows; row++) {
      const target = targets[row] ?? Number.NaN;
      if (!Number.isInteger(target) || target < 0 || target >= logits.columns)
        throw new RangeError(
          `The target ${target} of row ${row} is not one of the ${logits.columns} columns of the logits.`,
        );
      const values = logits.row(row);
      const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
      const logSum = Math.log(
        values.reduce((sum, value) => sum + Math.exp(value - max), 0),
      );
      const out = logSoftmax.row(row);
      for (const [column, value] of values.entries())
        out[column] = value - max - logSum;
      const weight = weights[row] ?? 0;
      total += -(out[target] ?? 0) * weight;
      weightSum += weight;
    }
    const denominator = Math.max(weightSum, WEIGHT_FLOOR);
    return {
      output: total / denominator,
      // ∂ℓᵢ/∂logit = softmax − one-hot of the target.
      pullback: (gradient) => {
        const logitsGradient = new Matrix(logits.rows, logits.columns);
        for (let row = 0; row < logits.rows; row++) {
          const scale = (gradient * (weights[row] ?? 0)) / denominator;
          const target = targets[row];
          const out = logitsGradient.row(row);
          for (const [column, value] of logSoftmax.row(row).entries())
            out[column] =
              scale * (Math.exp(value) - (column === target ? 1 : 0));
        }
        return logitsGradient;
      },
    };
  }
}
