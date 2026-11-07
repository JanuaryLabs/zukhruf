import { MT19937 } from '../bit-generator/mt19937.ts';
import { randomInterval } from './random-interval.ts';

// np.finfo(np.float32).eps.
const FLOAT32_EPSILON = 2 ** -23;

// The options of RandomState.choice: with replacement and the weights p, or
// without replacement and without p. NumPy's choice with both draws by
// another path, which this port does not prove.
type ChoiceOptions =
  | { readonly p: ArrayLike<number>; readonly replace?: never }
  | { readonly replace: false; readonly p?: never };

// numpy.random.RandomState, the legacy generator: the draws of mtrand.pyx
// over MT19937, whose stream NumPy keeps the same in each version (NEP 19).
export class RandomState {
  readonly #bits: MT19937;

  constructor(seed: number | bigint | MT19937) {
    this.#bits = seed instanceof MT19937 ? seed : MT19937.legacy(seed);
  }

  // random_sample(size): size floats in [0, 1) of 53 bits.
  randomSample(size: number): number[] {
    return Array.from({ length: size }, () => this.#bits.nextDouble());
  }

  // uniform(size=size), with low 0 and high 1: low + (high - low) *
  // random_sample(), which is random_sample().
  uniform(size: number): number[] {
    return this.randomSample(size);
  }

  // randint(low, high, size) of int64 for a range high - low from 1 to 2^32:
  // masked rejection on 32-bit draws (random_bounded_uint64_fill with
  // use_masked), which is random_interval.
  randint(low: number, high: number, size: number): number[] {
    const range = high - low;
    if (!(range > 0)) throw new RangeError('low >= high');
    if (range > 2 ** 32)
      throw new RangeError(
        `This port draws ranges of at most 2^32, not ${range}`,
      );
    return Array.from(
      { length: size },
      () => low + randomInterval(this.#bits, range - 1),
    );
  }

  // choice(a, size): size items of a, or of arange(a) when a is a number,
  // with replacement (randint), with the weights p, or without replacement
  // (permutation(n)[:size]).
  choice(a: number, size: number, options?: ChoiceOptions): number[];
  choice<T>(a: readonly T[], size: number, options?: ChoiceOptions): T[];
  choice<T>(
    a: number | readonly T[],
    size: number,
    options?: ChoiceOptions,
  ): (number | T)[] {
    const popSize = typeof a === 'number' ? a : a.length;
    if (popSize <= 0 && size !== 0)
      throw new RangeError(
        typeof a === 'number'
          ? 'a must be greater than 0 unless no samples are taken'
          : "'a' cannot be empty unless no samples are taken",
      );
    const indices = this.#choiceIndices(popSize, size, options);
    return typeof a === 'number'
      ? indices
      : indices.map((index) => {
          const item = a[index];
          if (item === undefined) throw new RangeError(`No item at ${index}`);
          return item;
        });
  }

  // permutation(n): a shuffle of arange(n).
  permutation(n: number): number[] {
    const values = Array.from({ length: n }, (_, index) => index);
    this.shuffle(values);
    return values;
  }

  // shuffle(x) in place: from the last index down, each item swaps with the
  // item at random_interval(i).
  shuffle(values: unknown[]): void {
    for (let i = values.length - 1; i >= 1; i--) {
      const j = randomInterval(this.#bits, i);
      [values[i], values[j]] = [values[j], values[i]];
    }
  }

  #choiceIndices(
    popSize: number,
    size: number,
    options: ChoiceOptions | undefined,
  ): number[] {
    if (options?.replace === false) {
      if (size > popSize)
        throw new RangeError(
          "Cannot take a larger sample than population when 'replace=False'",
        );
      return this.permutation(popSize).slice(0, size);
    }
    if (options?.p !== undefined)
      return this.#weighted(options.p, popSize, size);
    return this.randint(0, popSize, size);
  }

  // The cumulative sum of p in float64, divided by its last value, searched
  // on the right for each random_sample. p holds no NaN and no negative
  // value, and its Kahan sum is 1 within the square root of the epsilon of
  // its float type, as NumPy checks.
  #weighted(p: ArrayLike<number>, popSize: number, size: number): number[] {
    if (p.length !== popSize)
      throw new RangeError("'a' and 'p' must have same size");
    const weights = Array.from(p);
    const sum = RandomState.#kahanSum(weights);
    if (Number.isNaN(sum)) throw new RangeError('probabilities contain NaN');
    if (weights.some((weight) => weight < 0))
      throw new RangeError('probabilities are not non-negative');
    const tolerance = Math.sqrt(
      p instanceof Float32Array ? FLOAT32_EPSILON : Number.EPSILON,
    );
    if (Math.abs(sum - 1) > tolerance)
      throw new RangeError('probabilities do not sum to 1');
    const cdf = new Float64Array(p.length);
    let total = 0;
    for (let index = 0; index < p.length; index++) {
      total += p[index] ?? 0;
      cdf[index] = total;
    }
    const last = cdf[cdf.length - 1] ?? 1;
    for (let index = 0; index < cdf.length; index++)
      cdf[index] = (cdf[index] ?? 0) / last;
    return this.randomSample(size).map((value) => {
      let low = 0;
      let high = cdf.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((cdf[middle] ?? 0) <= value) low = middle + 1;
        else high = middle;
      }
      return low;
    });
  }

  // kahan_sum of mtrand.pyx.
  static #kahanSum(values: readonly number[]): number {
    let sum = values[0] ?? 0;
    let compensation = 0;
    for (const value of values.slice(1)) {
      const y = value - compensation;
      const t = sum + y;
      compensation = t - sum - y;
      sum = t;
    }
    return sum;
  }
}
