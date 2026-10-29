// The sum in the pairwise order of numpy.sum, bit for bit. The binormal fit
// stops when its log likelihood changes by less than 1e-9, and a sum in
// another order moves that stop by one iteration on real streams
// (docs/adr/0002).
export function sum(values: readonly number[]): number {
  return pairwise(values, 0, values.length);
}

// numpy's pairwise_sum: 8 running sums below 128 values, and halves cut at a
// multiple of 8 above.
function pairwise(values: readonly number[], start: number, n: number): number {
  const at = (index: number) => values[start + index] ?? 0;
  if (n < 8) {
    let total = 0;
    for (let index = 0; index < n; index++) total += at(index);
    return total;
  }
  if (n <= 128) {
    const running = [0, 1, 2, 3, 4, 5, 6, 7].map(at);
    let index = 8;
    for (; index < n - (n % 8); index += 8)
      for (let lane = 0; lane < 8; lane++)
        running[lane] = (running[lane] ?? 0) + at(index + lane);
    const [r0 = 0, r1 = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0, r6 = 0, r7 = 0] =
      running;
    let total = r0 + r1 + (r2 + r3) + (r4 + r5 + (r6 + r7));
    for (; index < n; index++) total += at(index);
    return total;
  }
  const half = Math.floor(n / 2) - (Math.floor(n / 2) % 8);
  return (
    pairwise(values, start, half) + pairwise(values, start + half, n - half)
  );
}

export function mean(values: readonly number[]): number {
  return sum(values) / values.length;
}

// The standard deviation of the values themselves (divided by n, not n - 1).
export function populationSd(values: readonly number[]): number {
  const centre = mean(values);
  return Math.sqrt(
    sum(values.map((value) => (value - centre) ** 2)) / values.length,
  );
}

// The logistic function, in the tanh form of the research code, so that the
// package gives its probabilities to the last bits.
export function logistic(logit: number): number {
  return 0.5 * (1 + Math.tanh(logit / 2));
}

// log(exp(a) + exp(b)) without overflow, as numpy.logaddexp.
export function logAddExp(a: number, b: number): number {
  if (a === b) return a + Math.LN2;
  const difference = a - b;
  return difference > 0
    ? a + Math.log1p(Math.exp(-difference))
    : b + Math.log1p(Math.exp(difference));
}
