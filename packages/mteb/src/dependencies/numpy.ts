// The NumPy 2.5 algorithms whose results MTEB depends on, for 1-D arrays of
// float64. gsumpw of stdlib is the pairwise summation of numpy's add loop
// (loops_utils.h): blocks of up to 128 values in 8 accumulators, larger arrays
// split in two.
import gsumpw from '@stdlib/blas-ext-base-gsumpw';

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
// sorted in increasing order.
export function percentile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * (q / 100);
  const below = Math.floor(position);
  const a = sorted[below] ?? Number.NaN;
  const b = sorted[Math.min(below + 1, sorted.length - 1)] ?? Number.NaN;
  const t = position - below;
  const difference = b - a;
  return t >= 0.5 ? b - difference * (1 - t) : a + difference * t;
}

// np.sum of a float32 array, also along the last axis of a C-contiguous
// array: the pairwise sum of numpy's add loop (loops_utils.h) in float32.
// Fewer than 8 values add in order; up to 128 values add in 8 accumulators;
// a longer array splits in two at a multiple of 8.
export function sumFloat32(values: ArrayLike<number>): number {
  return Math.fround(0 + pairwiseSumFloat32(values, 0, values.length));
}

function pairwiseSumFloat32(
  values: ArrayLike<number>,
  start: number,
  n: number,
): number {
  const at = (index: number) => values[start + index] ?? 0;
  if (n < 8) {
    let result = 0;
    for (let index = 0; index < n; index++)
      result = Math.fround(result + at(index));
    return result;
  }
  if (n <= 128) {
    const r = Array.from({ length: 8 }, (_, lane) => Math.fround(at(lane)));
    let index = 8;
    for (; index < n - (n % 8); index += 8)
      for (let lane = 0; lane < 8; lane++)
        r[lane] = Math.fround((r[lane] ?? 0) + at(index + lane));
    const add = (a: number, b: number) => Math.fround(a + b);
    const lane = (index: number) => r[index] ?? 0;
    let result = add(
      add(add(lane(0), lane(1)), add(lane(2), lane(3))),
      add(add(lane(4), lane(5)), add(lane(6), lane(7))),
    );
    for (; index < n; index++) result = Math.fround(result + at(index));
    return result;
  }
  let half = Math.floor(n / 2);
  half -= half % 8;
  return Math.fround(
    pairwiseSumFloat32(values, start, half) +
      pairwiseSumFloat32(values, start + half, n - half),
  );
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
