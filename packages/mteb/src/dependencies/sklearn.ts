import { sum } from './numpy.ts';

// sklearn.metrics.auc of scikit-learn 1.9: the area under a curve by the
// trapezoidal rule (np.trapezoid), for x that only rises or only falls.
export function auc(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length)
    throw new Error(
      `Found input variables with inconsistent numbers of samples: [${x.length}, ${y.length}]`,
    );
  if (x.length < 2)
    throw new Error(
      `At least 2 points are needed to compute area under curve, but x.shape = ${x.length}`,
    );
  const steps = x.slice(1).map((value, index) => value - (x[index] ?? 0));
  let direction = 1;
  if (steps.some((step) => step < 0)) {
    if (!steps.every((step) => step <= 0))
      throw new Error(
        `x is neither increasing nor decreasing : [${x.join(', ')}].`,
      );
    direction = -1;
  }
  const areas = steps.map(
    (step, index) => (step * ((y[index + 1] ?? 0) + (y[index] ?? 0))) / 2,
  );
  return direction * sum(areas);
}
