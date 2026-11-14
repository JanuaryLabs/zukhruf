import type { Differentiable } from './differentiable.ts';
import { Matrix } from './matrix.ts';

// The smallest norm that F.normalize of PyTorch divides by.
const NORM_EPSILON = 1e-12;

// F.normalize of PyTorch along each row: row / max(‖row‖, 1e-12), so a zero
// row stays zero.
export class Normalize {
  forward(input: Matrix): Differentiable<Matrix, Matrix> {
    const norms = Float64Array.from({ length: input.rows }, (_, row) =>
      Math.sqrt(input.row(row).reduce((sum, value) => sum + value * value, 0)),
    );
    const output = new Matrix(input.rows, input.columns);
    for (const [row, norm] of norms.entries()) {
      const divisor = Math.max(norm, NORM_EPSILON);
      output.row(row).set(input.row(row).map((value) => value / divisor));
    }
    return {
      output,
      // Below 1e-12 the divisor is a constant. Above it, the gradient of
      // y = x / ‖x‖ is (g − y (y · g)) / ‖x‖.
      pullback: (gradient) => {
        const inputGradient = new Matrix(input.rows, input.columns);
        for (const [row, norm] of norms.entries()) {
          const upstream = gradient.row(row);
          const unit = output.row(row);
          const projection = unit.reduce(
            (sum, value, index) => sum + value * (upstream[index] ?? 0),
            0,
          );
          inputGradient
            .row(row)
            .set(
              norm < NORM_EPSILON
                ? upstream.map((value) => value / NORM_EPSILON)
                : upstream.map(
                    (value, index) =>
                      (value - (unit[index] ?? 0) * projection) / norm,
                  ),
            );
        }
        return inputGradient;
      },
    };
  }
}
