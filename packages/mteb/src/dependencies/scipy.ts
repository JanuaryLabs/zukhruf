import { argsortStable, corrcoef, mean, sum } from './numpy.ts';
import { pythonRoundToInteger } from './python.ts';

// The SciPy 1.18 statistics that MTEB's STS task uses, for 1-D arrays of
// float64.

// scipy.stats.rankdata with method="average": the rank of each value from 1,
// and the mean rank for equal values. With a NaN, each rank is NaN
// (nan_policy="propagate").
export function rankdata(values: ArrayLike<number>): number[] {
  if (Array.from(values).some(Number.isNaN))
    return Array.from(values, () => Number.NaN);
  const order = argsortStable(values);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    const value = values[order[start] ?? 0];
    let end = start + 1;
    while (end < order.length && values[order[end] ?? 0] === value) end++;
    const rank = start + 1 + (end - start - 1) / 2;
    for (let index = start; index < end; index++)
      ranks[order[index] ?? 0] = rank;
    start = end;
  }
  return ranks;
}

// scipy.stats.spearmanr(a, b)[0]: np.corrcoef of the average ranks. It is
// NaN for fewer than 2 values, with a NaN, and for a constant array.
export function spearmanr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length)
    throw new Error(
      `all the input array dimensions except for the concatenation axis must match exactly, but along dimension 0, the array at index 0 has size ${a.length} and the array at index 1 has size ${b.length}`,
    );
  if (a.length <= 1) return Number.NaN;
  if ([...Array.from(a), ...Array.from(b)].some(Number.isNaN))
    return Number.NaN;
  return corrcoef(rankdata(a), rankdata(b));
}

// scipy.stats.pearsonr(x, y)[0]: the dot product of the centred arrays, each
// divided by its norm, clipped to [-1, 1]. It is NaN for a constant array,
// and -1, 1 or NaN for 2 values. SciPy calls np.vecdot, which adds with BLAS
// ddot; this port adds in order, so the result can differ in its last bits.
export function pearsonr(x: ArrayLike<number>, y: ArrayLike<number>): number {
  if (x.length !== y.length)
    throw new Error('`x` and `y` must have the same length along `axis`.');
  if (x.length < 2) throw new Error('`x` and `y` must have length at least 2.');
  const constant = (values: ArrayLike<number>) =>
    Array.from(values).every((value) => value === values[0]);
  if (constant(x) || constant(y)) return Number.NaN;
  const xUnit = unit(x);
  const yUnit = unit(y);
  let r = 0;
  for (let index = 0; index < xUnit.length; index++)
    r += (xUnit[index] ?? 0) * (yUnit[index] ?? 0);
  r = Math.min(1, Math.max(-1, r));
  // np.round of r, half to even. For 2 values r is -1, 1 or NaN up to
  // rounding, so the sign of a zero cannot differ.
  return x.length === 2 ? pythonRoundToInteger(r) : r;
}

// (x - mean) / norm, with the norm scaled by the largest |x - mean| first, as
// pearsonr does to avoid an overflow. np.linalg.norm along an axis is the
// square root of the pairwise sum of the squares.
function unit(values: ArrayLike<number>): number[] {
  const average = mean(values);
  const centred = Array.from(values, (value) => value - average);
  let largest = 0;
  for (const value of centred) largest = Math.max(largest, Math.abs(value));
  const scaled = centred.map((value) => {
    const part = value / largest;
    return part * part;
  });
  const norm = largest * Math.sqrt(sum(scaled));
  return centred.map((value) => value / norm);
}
