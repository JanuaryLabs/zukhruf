import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { LogisticRegression } from './sklearn-logistic.ts';
import type { ClassLabel } from './sklearn.ts';

// fixtures/logistic-regression/expected.json holds what scikit-learn 1.9.1's
// LogisticRegression(max_iter=max_iter) gave for float32 data made in
// generate.py: coef_, intercept_ and n_iter_ after fit, and
// decision_function and predict of test data. generate.py makes it.
type Case = {
  readonly case: string;
  readonly max_iter: number;
  readonly x: number[][];
  readonly y: ClassLabel[];
  readonly x_test: number[][];
  readonly classes: ClassLabel[];
  readonly coef: number[][];
  readonly intercept: number[];
  readonly n_iter: number;
  readonly decision_function: number[][];
  readonly predict: ClassLabel[];
};

const expected: { readonly cases: readonly Case[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/logistic-regression/expected.json'),
    'utf8',
  ),
);

// The loss and the gradient round the values that scikit-learn rounds to
// float32, but L-BFGS-B and the dot products of two classes add in another
// order than Accelerate's BLAS (sklearn-logistic.ts). After one iteration
// or none, the coefficients and the intercepts equal scikit-learn's to the
// last bit. After more iterations, they and the decision values are within
// TOLERANCE * max(1, |value|) of scikit-learn's. The largest difference seen
// is 8.1e-5, in a decision value of the five overlapping classes.
const TOLERANCE = 2e-4;

function assertClose(
  actual: ArrayLike<number>,
  python: readonly number[],
  what: string,
  tolerance = TOLERANCE,
): void {
  assert.equal(actual.length, python.length, what);
  for (const [i, value] of python.entries())
    assert.ok(
      Math.abs((actual[i] ?? Number.NaN) - value) <=
        tolerance * Math.max(1, Math.abs(value)),
      `${what}[${i}]: ${actual[i]} and ${value}`,
    );
}

function float32Rows(rows: readonly number[][]): Float32Array[] {
  return rows.map((row) => Float32Array.from(row));
}

for (const logisticCase of expected.cases)
  test(`LogisticRegression gives scikit-learn's classes, n_iter_ and predictions, and coefficients within 2e-4, exact after one iteration: ${logisticCase.case}`, () => {
    const model = new LogisticRegression({ maxIter: logisticCase.max_iter });

    const fitted = model.fit(float32Rows(logisticCase.x), logisticCase.y);
    const xTest = float32Rows(logisticCase.x_test);

    assert.deepEqual(
      {
        classes: fitted.classes,
        nIter: fitted.nIter,
        predict: fitted.predict(xTest),
      },
      {
        classes: logisticCase.classes,
        nIter: logisticCase.n_iter,
        predict: logisticCase.predict,
      },
    );
    const tolerance = logisticCase.n_iter <= 1 ? 0 : TOLERANCE;
    assert.equal(fitted.coef.length, logisticCase.coef.length);
    for (const [c, row] of logisticCase.coef.entries())
      assertClose(fitted.coef[c] ?? [], row, `coef[${c}]`, tolerance);
    assertClose(
      fitted.intercept,
      logisticCase.intercept,
      'intercept',
      tolerance,
    );
    for (const [i, row] of fitted.decisionFunction(xTest).entries())
      assertClose(
        row,
        logisticCase.decision_function[i] ?? [],
        `decision_function[${i}]`,
      );
  });

test('labels of one class throw, as scikit-learn raises a ValueError', () => {
  const model = new LogisticRegression();

  assert.throws(
    () => model.fit([Float32Array.of(1), Float32Array.of(2)], [3, 3]),
    {
      message:
        'This solver needs samples of at least 2 classes in the data, but the data contains only one class: np.int64(3)',
    },
  );
});
