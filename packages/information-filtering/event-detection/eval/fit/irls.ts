// Logistic regression over standardized features, fitted by IRLS
// (Newton-Raphson), the textbook maximum-likelihood method (Hastie et al.,
// ESL section 4.4.1). Moved from research round #3130
// (feature-scorer-3130/scripts/model.ts, itself a copy of the one of round
// #3124). mljs ml-logistic-regression 2.0.0 is fixed-step gradient ascent with
// no intercept and no stopping rule: on 64,950 pairs, 8,000 steps took 51 s
// and the weights still moved. IRLS reaches the optimum in about 10
// iterations. ml-matrix solves the linear system.
import { Matrix, solve } from 'ml-matrix';

export const TRAINING = {
  method: 'IRLS (Newton-Raphson)',
  maxIterations: 100,
  tolerance: 1e-9,
  ridge: 1e-6,
} as const;

export type Fitted = {
  // The mean and the population standard deviation of each feature.
  readonly mean: readonly number[];
  readonly sd: readonly number[];
  // The intercept, then one weight for each standardized feature.
  readonly weights: readonly number[];
  readonly rows: number;
  readonly positives: number;
  readonly iterations: number;
};

// rows[i] holds the features of row i, and labels[i] is 1 or 0. A feature
// with a standard deviation of 0 is divided by 1.
export function fit(
  rows: readonly (readonly number[])[],
  labels: readonly number[],
): Fitted {
  const n = rows.length;
  const columns = rows[0]?.length ?? 0;
  const d = columns + 1;
  const mean = Array.from(
    { length: columns },
    (_, c) => rows.reduce((sum, row) => sum + row[c]!, 0) / n,
  );
  const sd = Array.from(
    { length: columns },
    (_, c) =>
      Math.sqrt(
        rows.reduce((sum, row) => sum + (row[c]! - mean[c]!) ** 2, 0) / n,
      ) || 1,
  );
  const x = rows.map((row) => [
    1,
    ...row.map((value, c) => (value - mean[c]!) / sd[c]!),
  ]);
  let weights = new Array<number>(d).fill(0);
  let iterations = 0;
  for (; iterations < TRAINING.maxIterations; iterations++) {
    const hessian = Matrix.zeros(d, d);
    const gradient = Matrix.zeros(d, 1);
    for (const [i, xi] of x.entries()) {
      let z = 0;
      for (let a = 0; a < d; a++) z += weights[a]! * xi[a]!;
      const p = 1 / (1 + Math.exp(-z));
      const q = p * (1 - p);
      const error = labels[i]! - p;
      for (let a = 0; a < d; a++) {
        gradient.set(a, 0, gradient.get(a, 0) + xi[a]! * error);
        for (let b = 0; b <= a; b++)
          hessian.set(a, b, hessian.get(a, b) + q * xi[a]! * xi[b]!);
      }
    }
    for (let a = 0; a < d; a++) {
      hessian.set(a, a, hessian.get(a, a) + TRAINING.ridge * n);
      for (let b = 0; b < a; b++) hessian.set(b, a, hessian.get(a, b));
    }
    for (let a = 0; a < d; a++)
      gradient.set(a, 0, gradient.get(a, 0) - TRAINING.ridge * n * weights[a]!);
    const step = solve(hessian, gradient).to1DArray();
    weights = weights.map((value, a) => value + step[a]!);
    if (Math.max(...step.map(Math.abs)) < TRAINING.tolerance) break;
  }
  if (iterations === TRAINING.maxIterations)
    throw new Error('IRLS did not converge.');
  return {
    mean,
    sd,
    weights,
    rows: n,
    positives: labels.reduce((sum, label) => sum + label, 0),
    iterations: iterations + 1,
  };
}
