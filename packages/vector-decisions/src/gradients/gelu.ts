import { createRequire } from 'node:module';

import type * as Cephes from 'cephes' with { 'resolution-mode': 'require' };

import type { Differentiable } from './differentiable.ts';
import { Matrix } from './matrix.ts';

// The CommonJS entry of cephes compiles its WebAssembly synchronously, so
// GELU requires it at its first pass (as PreparedQuestion does).
const require = createRequire(import.meta.url);

// φ(0), the normal density at 0: 1 / √(2π).
const DENSITY_AT_ZERO = 1 / Math.sqrt(2 * Math.PI);

// nn.GELU of PyTorch, the exact form: x · Φ(x), with Φ the normal CDF, written
// as PyTorch's CPU kernel writes it.
export class GELU {
  forward(input: Matrix): Differentiable<Matrix, Matrix> {
    const cephes: typeof Cephes = require('cephes');
    const output = new Matrix(
      input.rows,
      input.columns,
      input.values.map((x) => x * 0.5 * (1 + cephes.erf(x * Math.SQRT1_2))),
    );
    return {
      output,
      // d/dx x · Φ(x) = Φ(x) + x · φ(x)
      pullback: (gradient) =>
        new Matrix(
          input.rows,
          input.columns,
          gradient.values.map((value, index) => {
            const x = input.values[index] ?? 0;
            const cdf = 0.5 * (1 + cephes.erf(x * Math.SQRT1_2));
            const pdf = DENSITY_AT_ZERO * Math.exp(x * x * -0.5);
            return value * (cdf + x * pdf);
          }),
        ),
    };
  }
}
