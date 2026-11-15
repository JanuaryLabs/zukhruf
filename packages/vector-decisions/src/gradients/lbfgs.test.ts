import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { LBFGS } from './lbfgs.ts';
import { Matrix } from './matrix.ts';
import { Parameter } from './parameter.ts';

// The parameters at each call of the closure, and after the step, of
// torch.optim.LBFGS with line_search_fn="strong_wolfe" (fixtures/
// generate_lbfgs.py). Each value is the flat list of all the parameters.
const golden: readonly {
  readonly name: string;
  readonly function: 'quartic' | 'bump' | 'rosenbrock';
  readonly coefficients: readonly number[];
  readonly parameters: readonly number[][][];
  readonly maxIter: number;
  readonly calls: readonly number[][];
  readonly final: readonly number[];
}[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/lbfgs.json'), 'utf8'),
);

// Relative to each value: the paths reach values near 1e-8, where an
// absolute bound would let a changed step through. The port is within 5.9e-12
// of torch's values, and bit for bit where torch's value is 0.
const GOLDEN_TOLERANCE = 1e-9;

type Objective = (
  values: Float64Array,
  coefficients: readonly number[],
) => { readonly loss: number; readonly gradient: Float64Array };

// The functions of generate_lbfgs.py. Each loss is written with the same
// operations in the same order as there, so that it equals torch's bit for
// bit; a loss that differed by a rounding could flip a comparison of the line
// search and send the port down another path.
const objectives: Record<(typeof golden)[number]['function'], Objective> = {
  quartic: ([value = 0], [s = 0, b = 0, c = 0, e = 0, w = 1]) => {
    const x = value / w;
    return {
      loss: s * (x * x * x * x - b * x * x * x - c * x * x + e * x),
      gradient: Float64Array.of(
        (s * (4 * x * x * x - 3 * b * x * x - 2 * c * x + e)) / w,
      ),
    };
  },
  bump: ([value = 0], [s = 0, e = 0, w = 1]) => {
    const u = value / w;
    const q = 1 + u * u;
    return {
      loss: (s * u) / q + e * u * u,
      gradient: Float64Array.of(((s * (1 - u * u)) / (q * q) + 2 * e * u) / w),
    };
  },
  rosenbrock: (values) => {
    let loss = 0;
    const gradient = new Float64Array(values.length);
    for (let i = 0; i + 1 < values.length; i++) {
      const x = values[i] ?? 0;
      const next = values[i + 1] ?? 0;
      loss = loss + 100 * (next - x * x) * (next - x * x) + (1 - x) * (1 - x);
      gradient[i] = (gradient[i] ?? 0) - 400 * x * (next - x * x) - 2 * (1 - x);
      gradient[i + 1] = (gradient[i + 1] ?? 0) + 200 * (next - x * x);
    }
    return { loss, gradient };
  },
};

// Each number of actual is within tolerance · |expected| of expected.
function assertClose(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  label: string,
): void {
  assert.equal(actual.length, expected.length, label);
  for (let index = 0; index < expected.length; index++) {
    const got = actual[index] ?? Number.NaN;
    const want = expected[index] ?? Number.NaN;
    assert.ok(
      Math.abs(got - want) <= GOLDEN_TOLERANCE * Math.abs(want),
      `${label}[${index}]: ${got} against ${want}`,
    );
  }
}

// Any change to a step of the line search, to its stops or to the direction
// moves the points at which the closure is called, so the whole path is
// compared, not only where it ends.
test('LBFGS calls the closure at the parameters at which torch.optim.LBFGS calls it, and ends where it ends', async (t) => {
  for (const {
    name,
    function: objective,
    coefficients,
    parameters,
    maxIter,
    calls,
    final,
  } of golden)
    await t.test(name, () => {
      const trained = parameters.map(
        (rows) => new Parameter(Matrix.fromRows(rows)),
      );
      const flat = (): Float64Array =>
        Float64Array.from(trained.flatMap((p) => [...p.value.values]));
      const recorded: Float64Array[] = [];

      new LBFGS(trained, { maxIter }).step(() => {
        const values = flat();
        recorded.push(values);
        const { loss, gradient } = objectives[objective](values, coefficients);
        let offset = 0;
        for (const { gradient: own } of trained) {
          own.values.set(gradient.subarray(offset, offset + own.values.length));
          offset += own.values.length;
        }
        return loss;
      });

      assert.equal(recorded.length, calls.length, `${name}: calls`);
      for (const [index, values] of recorded.entries())
        assertClose(values, calls[index] ?? [], `${name}: call ${index + 1}`);
      assertClose(flat(), final, `${name}: final`);
    });
});
