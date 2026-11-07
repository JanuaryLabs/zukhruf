import { sum } from './sum.ts';

// numpy.mean of a 1-D float64 array: numpy.sum divided by the number of
// values. The mean of no values is NaN, as NumPy gives it.
export function mean(values: ArrayLike<number>): number {
  return sum(values) / values.length;
}
