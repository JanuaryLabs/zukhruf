import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { type Bound, minimizeLbfgsb } from './scipy-lbfgsb.ts';

// fixtures/lbfgsb/expected.json holds what scipy.optimize.minimize
// (method="L-BFGS-B", jac=True) of SciPy 1.18.1 returned for a quadratic and
// the Rosenbrock function, with and without bounds, and with the options of
// scikit-learn's LogisticRegression. generate.py makes it.
type Case = {
  readonly case: string;
  readonly function: 'quadratic' | 'rosenbrock';
  readonly x0: number[];
  readonly options: Readonly<Record<string, number>>;
  readonly bounds: readonly (readonly (number | string)[])[] | null;
  readonly result: {
    readonly x: number[];
    readonly fun: number;
    readonly jac: number[];
    readonly nit: number;
    readonly nfev: number;
    readonly status: number;
    readonly message: string;
  };
};

const expected: { readonly cases: readonly Case[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/lbfgsb/expected.json'),
    'utf8',
  ),
);

// The functions of generate.py, with the same additions in the same order.
function quadratic(x: Float64Array): [number, number[]] {
  const a = [1, 2, 3, 0.5, 4, 1.5];
  const c = [1, -2, 0.5, 3, -1, 2];
  let f = 0;
  const g = new Array<number>(x.length).fill(0);
  for (let i = 0; i < x.length; i++) {
    const diff = (x[i] ?? 0) - (c[i] ?? 0);
    f += (a[i] ?? 0) * diff * diff;
    g[i] = (g[i] ?? 0) + 2 * (a[i] ?? 0) * diff;
  }
  for (let i = 0; i < x.length - 1; i++) {
    f += 0.5 * (x[i] ?? 0) * (x[i + 1] ?? 0);
    g[i] = (g[i] ?? 0) + 0.5 * (x[i + 1] ?? 0);
    g[i + 1] = (g[i + 1] ?? 0) + 0.5 * (x[i] ?? 0);
  }
  return [f, g];
}

function rosenbrock(x: Float64Array): [number, number[]] {
  let f = 0;
  const g = new Array<number>(x.length).fill(0);
  for (let i = 0; i < x.length - 1; i++) {
    const t = (x[i + 1] ?? 0) - (x[i] ?? 0) * (x[i] ?? 0);
    const s = 1 - (x[i] ?? 0);
    f += 100 * t * t + s * s;
    g[i] = (g[i] ?? 0) + (-400 * (x[i] ?? 0) * t - 2 * s);
    g[i + 1] = (g[i + 1] ?? 0) + 200 * t;
  }
  return [f, g];
}

const FUNCTIONS = { quadratic, rosenbrock };

function bounds(source: Case['bounds']): Bound[] | undefined {
  if (source === null) return undefined;
  const bound = (value: number | string | undefined) =>
    typeof value === 'string'
      ? Number(value.replace('inf', 'Infinity'))
      : (value ?? Number.NaN);
  return source.map(([lower, upper]) => [bound(lower), bound(upper)]);
}

// SciPy adds its dot products with Accelerate's BLAS, in another order than
// this port. The counts, the status and the message are equal; x and f are
// within TOLERANCE * max(1, |value|). The largest difference seen is 3.1e-7
// in x, for the Rosenbrock function in 7 variables, where the last steps
// move along a flat valley.
const TOLERANCE = 1e-6;

// The gradient at x moves with x: its largest difference is 4.2e-6, in the
// Rosenbrock function in 7 variables.
const JAC_TOLERANCE = 1e-5;

function assertClose(
  actual: number,
  python: number,
  what: string,
  tolerance = TOLERANCE,
): void {
  assert.ok(
    Math.abs(actual - python) <= tolerance * Math.max(1, Math.abs(python)),
    `${what}: ${actual} and ${python}`,
  );
}

for (const lbfgsbCase of expected.cases)
  test(`L-BFGS-B gives SciPy's iterations, evaluations and stop, x and f within 1e-6 and the gradient within 1e-5: ${lbfgsbCase.case}`, () => {
    const { result } = lbfgsbCase;

    const bounded = bounds(lbfgsbCase.bounds);
    const actual = minimizeLbfgsb(
      FUNCTIONS[lbfgsbCase.function],
      lbfgsbCase.x0,
      bounded === undefined
        ? lbfgsbCase.options
        : { ...lbfgsbCase.options, bounds: bounded },
    );

    assert.deepEqual(
      {
        nit: actual.nit,
        nfev: actual.nfev,
        status: actual.status,
        message: actual.message,
      },
      {
        nit: result.nit,
        nfev: result.nfev,
        status: result.status,
        message: result.message,
      },
    );
    for (const [i, value] of result.x.entries())
      assertClose(actual.x[i] ?? Number.NaN, value, `x[${i}]`);
    assertClose(actual.fun, result.fun, 'fun');
    for (const [i, value] of result.jac.entries())
      assertClose(
        actual.jac[i] ?? Number.NaN,
        value,
        `jac[${i}]`,
        JAC_TOLERANCE,
      );
  });

test('bounds of another length than x0 throw, as SciPy raises a ValueError', () => {
  assert.throws(() => minimizeLbfgsb(quadratic, [0, 0], { bounds: [[0, 1]] }), {
    message: 'length of x0 != length of bounds',
  });
});

test('a lower bound above its upper bound throws, as SciPy raises a ValueError', () => {
  assert.throws(() => minimizeLbfgsb(quadratic, [0], { bounds: [[1, 0]] }), {
    message: 'LBFGSB - one of the lower bounds is greater than an upper bound.',
  });
});
