// The NumPy 2.5 algorithms whose results MTEB depends on, for 1-D arrays of
// float64. gsumpw of stdlib is the pairwise summation of numpy's add loop
// (loops_utils.h): blocks of up to 128 values in 8 accumulators, larger arrays
// split in two. ssumpw is the same summation in float32.
import gsumpw from '@stdlib/blas-ext-base-gsumpw';
import ssumpw from '@stdlib/blas-ext-base-ssumpw';

// np.sum: the identity 0 plus the pairwise sum.
export function sum(values: ArrayLike<number>): number {
  return 0 + gsumpw(values.length, values, 1);
}

// np.mean. NumPy gives NaN for an empty array.
export function mean(values: ArrayLike<number>): number {
  return sum(values) / values.length;
}

// np.std with ddof=0.
export function std(values: ArrayLike<number>): number {
  const average = mean(values);
  const squares = Array.from(values, (value) => {
    const deviation = value - average;
    return deviation * deviation;
  });
  return Math.sqrt(sum(squares) / values.length);
}

// np.add.reduceat for increasing starts: each segment is its first value plus
// the pairwise sum of the rest. As numpy's documentation says, the segment of
// the last start runs to the end of the values. A start outside the values
// throws, where numpy raises an IndexError.
export function addReduceat(
  values: ArrayLike<number>,
  starts: readonly number[],
): number[] {
  return starts.map((start, index) => {
    const first = values[start];
    if (first === undefined)
      throw new RangeError(
        `index ${start} out-of-bounds in add.reduceat [0, ${values.length})`,
      );
    const end = starts[index + 1] ?? values.length;
    return first + gsumpw.ndarray(end - start - 1, values, 1, start + 1);
  });
}

// np.argsort(values, stable=True).
export function argsortStable(values: ArrayLike<number>): number[] {
  return Array.from(values, (_, index) => index).sort((left, right) => {
    const a = values[left] ?? 0;
    const b = values[right] ?? 0;
    if (a < b) return -1;
    if (a > b) return 1;
    return left - right;
  });
}

// np.linspace(start, stop, num).
export function linspace(start: number, stop: number, num: number): number[] {
  const step = (stop - start) / (num - 1);
  return Array.from({ length: num }, (_, index) =>
    index === num - 1 && num > 1 ? stop : index * step + start,
  );
}

// np.percentile(values, q) with the default method "linear", for values
// sorted in increasing order: np.quantile of q / 100.
export function percentile(sorted: readonly number[], q: number): number {
  return quantile(sorted, q / 100);
}

// np.quantile(values, q) with the default method "linear", for values sorted
// in increasing order.
export function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const a = sorted[below] ?? Number.NaN;
  const b = sorted[Math.min(below + 1, sorted.length - 1)] ?? Number.NaN;
  const t = position - below;
  const difference = b - a;
  return t >= 0.5 ? b - difference * (1 - t) : a + difference * t;
}

// np.sum of a float32 array, also along the last axis of a C-contiguous
// array: the identity 0 plus the float32 pairwise sum.
export function sumFloat32(values: Float32Array): number {
  return 0 + ssumpw(values.length, values, 1);
}

// np.mean of a float32 array: the float32 pairwise sum divided by the
// number of values, in float32.
export function meanFloat32(values: Float32Array): number {
  return Math.fround(sumFloat32(values) / values.length);
}

// np.mean(rows, axis=0) of a C-contiguous float32 matrix: numpy adds the rows
// one after the other in float32, then divides each sum by the number of rows.
export function meanAxis0Float32(rows: readonly Float32Array[]): Float32Array {
  const [first, ...rest] = rows;
  if (first === undefined) throw new RangeError('np.mean of no rows.');
  const sums = Float32Array.from(first);
  for (const row of rest)
    for (let column = 0; column < sums.length; column++)
      sums[column] = (sums[column] ?? 0) + (row[column] ?? 0);
  return sums.map((value) => Math.fround(value / rows.length));
}

// np.corrcoef(np.column_stack((x, y)), rowvar=False)[1, 0]: the covariance
// matrix of np.cov (ddof 1, scaled by 1 / (n - 1)), each entry divided by the
// standard deviation of its row and then of its column, clipped to [-1, 1].
// np.cov multiplies the centred rows with BLAS, whose order of addition this
// port does not copy. Thus the result equals numpy's only when each sum of
// products is exact, as for the ranks of fewer than 2 ** 18 values: centred
// ranks are multiples of 0.5.
export function corrcoef(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const xMean = mean(x);
  const yMean = mean(y);
  let xx = 0;
  let yy = 0;
  let yx = 0;
  for (let index = 0; index < x.length; index++) {
    const xm = (x[index] ?? 0) - xMean;
    const ym = (y[index] ?? 0) - yMean;
    xx += xm * xm;
    yy += ym * ym;
    yx += ym * xm;
  }
  const scale = 1 / Math.max(x.length - 1, 0);
  const r = (yx * scale) / Math.sqrt(yy * scale) / Math.sqrt(xx * scale);
  return Math.min(1, Math.max(-1, r));
}
