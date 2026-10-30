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
