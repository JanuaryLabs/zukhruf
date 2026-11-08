import { sum } from './sum.ts';

// numpy.nanmean of a 1-D float64 array: each NaN becomes 0, sum adds all the
// values in numpy's pairwise order, and the sum is divided by the number of
// values that are not NaN. A mean of only the values that are not NaN adds in
// other blocks and can give other last bits. No values, or only NaN values,
// give NaN, as NumPy gives them.
export function nanmean(values: ArrayLike<number>): number {
  let counted = 0;
  const zeroed = Float64Array.from(values, (value) => {
    if (Number.isNaN(value)) return 0;
    counted += 1;
    return value;
  });
  return sum(zeroed) / counted;
}
