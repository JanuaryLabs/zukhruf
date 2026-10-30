// The NumPy 2.5 algorithms whose results MTEB depends on, for 1-D arrays of
// float64.

// The pairwise summation of numpy's add loop (loops_utils.h): blocks of up to
// 128 values in 8 accumulators, larger arrays split in two.
function pairwiseSum(
  values: ArrayLike<number>,
  start: number,
  length: number,
): number {
  if (length < 8) {
    let sum = 0;
    for (let index = 0; index < length; index++)
      sum += values[start + index] ?? 0;
    return sum;
  }
  if (length <= 128) {
    const partial = Array.from(
      { length: 8 },
      (_, lane) => values[start + lane] ?? 0,
    );
    let index = 8;
    for (; index < length - (length % 8); index += 8)
      for (let lane = 0; lane < 8; lane++)
        partial[lane] =
          (partial[lane] ?? 0) + (values[start + index + lane] ?? 0);
    const [p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0] =
      partial;
    let sum = p0 + p1 + (p2 + p3) + (p4 + p5 + (p6 + p7));
    for (; index < length; index++) sum += values[start + index] ?? 0;
    return sum;
  }
  let half = Math.trunc(length / 2);
  half -= half % 8;
  return (
    pairwiseSum(values, start, half) +
    pairwiseSum(values, start + half, length - half)
  );
}

// np.sum: the identity 0 plus the pairwise sum.
export function sum(values: ArrayLike<number>): number {
  return 0 + pairwiseSum(values, 0, values.length);
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
// the pairwise sum of the rest.
export function addReduceat(
  values: ArrayLike<number>,
  starts: readonly number[],
): number[] {
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? values.length;
    return (
      (values[start] ?? 0) + pairwiseSum(values, start + 1, end - start - 1)
    );
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
