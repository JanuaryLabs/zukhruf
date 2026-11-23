import { mean } from './mean.ts';
import { sum } from './sum.ts';

// numpy.std of a 1-D float64 array (_var of numpy/_core/_methods.py): the
// mean, the square of each deviation from it, the pairwise sum of the
// squares divided by max(n - ddof, 0), and the square root. ddof 0 gives the
// population standard deviation, and ddof 1 the sample one. No values give
// NaN, and a ddof of n or more gives NaN or Infinity, as NumPy gives them.
export function std(
  values: ArrayLike<number>,
  { ddof = 0 }: { readonly ddof?: number } = {},
): number {
  const average = mean(values);
  const squares = Float64Array.from(values, (value) => {
    const deviation = value - average;
    return deviation * deviation;
  });
  return Math.sqrt(sum(squares) / Math.max(values.length - ddof, 0));
}
