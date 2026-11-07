import { mean, sum } from '@zukhruf/statistics';

// The standard deviation of the values themselves (divided by n, not n - 1).
export function populationSd(values: readonly number[]): number {
  const centre = mean(values);
  return Math.sqrt(
    sum(values.map((value) => (value - centre) ** 2)) / values.length,
  );
}

// The logistic function, in the tanh form of the research code, so that the
// package gives its probabilities to the last bits.
export function logistic(logit: number): number {
  return 0.5 * (1 + Math.tanh(logit / 2));
}

// log(exp(a) + exp(b)) without overflow, as numpy.logaddexp.
export function logAddExp(a: number, b: number): number {
  if (a === b) return a + Math.LN2;
  const difference = a - b;
  return difference > 0
    ? a + Math.log1p(Math.exp(-difference))
    : b + Math.log1p(Math.exp(difference));
}
