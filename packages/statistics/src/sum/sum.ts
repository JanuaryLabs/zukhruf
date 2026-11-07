import gsumpw from '@stdlib/blas-ext-base-gsumpw';

// numpy.sum of a 1-D float64 array: the identity 0 plus numpy's pairwise sum
// (pairwise_sum of loops_utils.h), which gsumpw of stdlib gives in the same
// order: blocks of up to 128 values in 8 accumulators, larger arrays cut in
// two halves, the first a multiple of 8. The identity makes a sum of -0.0
// values 0.0, as NumPy gives it.
export function sum(values: ArrayLike<number>): number {
  return 0 + gsumpw(values.length, values, 1);
}
