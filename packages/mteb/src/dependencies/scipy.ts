import { log } from './libm.ts';
import { argsortStable, corrcoef, mean, sum } from './numpy.ts';
import { pythonRoundToInteger } from './python.ts';

// The SciPy 1.18 statistics that MTEB's STS task uses, for 1-D arrays of
// float64.

// scipy.stats.rankdata: the rank of each value from 1. Equal values get
// their mean rank with method "average", and their largest rank with "max".
// With a NaN, each rank is NaN (nan_policy="propagate").
export function rankdata(
  values: ArrayLike<number>,
  method: 'average' | 'max' = 'average',
): number[] {
  if (Array.from(values).some(Number.isNaN))
    return Array.from(values, () => Number.NaN);
  const order = argsortStable(values);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    const value = values[order[start] ?? 0];
    let end = start + 1;
    while (end < order.length && values[order[end] ?? 0] === value) end++;
    const rank = method === 'max' ? end : start + 1 + (end - start - 1) / 2;
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

// scipy.special.gammaln for x >= 1: lgam of Cephes (xsf/cephes/gamma.h), a
// rational function between 2 and 3 after the recurrence below 13, and
// Stirling's series from 13. It calls the correctly rounded log of libm.ts.
// SciPy calls the log of the C library, so a value can differ in its last
// bits.
// The coefficients of gamma.h, as the float64 values that C reads.
const GAMMA_A = [
  0.000_811_614_167_470_508_5, -0.000_595_061_904_284_301_4,
  0.000_793_650_340_457_716_9, -0.002_777_777_777_300_997,
  0.083_333_333_333_333_19,
];
const GAMMA_B = [
  -1378.251_525_691_208_6, -38_801.631_513_463_784, -331_612.992_738_871_2,
  -1_162_370.974_927_623, -1_721_737.008_208_396_6, -853_555.664_245_765_4,
];
const GAMMA_C = [
  -351.815_701_436_523_45, -17_064.210_665_188_115, -220_528.590_553_854_45,
  -1_139_334.443_679_825_2, -2_532_523.071_775_829_4, -2_018_891.414_335_327_7,
];
const LS2PI = 0.918_938_533_204_672_8;

function polevl(x: number, coefficients: readonly number[]): number {
  let answer = coefficients[0] ?? 0;
  for (const coefficient of coefficients.slice(1))
    answer = answer * x + coefficient;
  return answer;
}

function p1evl(x: number, coefficients: readonly number[]): number {
  let answer = x + (coefficients[0] ?? 0);
  for (const coefficient of coefficients.slice(1))
    answer = answer * x + coefficient;
  return answer;
}

export function gammaln(x: number): number {
  if (!(x >= 1))
    throw new RangeError(`This port of gammaln takes x >= 1, not ${x}.`);
  if (x === Infinity) return x;
  if (x < 13) {
    let z = 1;
    let p = 0;
    let u = x;
    while (u >= 3) {
      p -= 1;
      u = x + p;
      z *= u;
    }
    while (u < 2) {
      z /= u;
      p += 1;
      u = x + p;
    }
    if (u === 2) return log(z);
    p -= 2;
    const shifted = x + p;
    return (
      log(z) + (shifted * polevl(shifted, GAMMA_B)) / p1evl(shifted, GAMMA_C)
    );
  }
  const q = (x - 0.5) * log(x) - x + LS2PI;
  if (x >= 1000) {
    if (x > 1e8) return q;
    const p = 1 / (x * x);
    return (
      q +
      ((0.000_793_650_793_650_793_7 * p - 0.002_777_777_777_777_778) * p +
        0.083_333_333_333_333_33) /
        x
    );
  }
  return q + polevl(1 / (x * x), GAMMA_A) / x;
}
