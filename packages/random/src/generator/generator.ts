import type { BitGenerator } from '../bit-generator/bit-generator.ts';
import { boundedLemire } from './bounded-lemire.ts';
import { randomInterval } from './random-interval.ts';

// The options of Generator.choice. Without replace, it chooses with
// replacement, as NumPy does.
type ChoiceOptions = { readonly replace?: boolean };

// numpy.random.Generator: the draws of _generator.pyx over the bits of one
// bit generator (Bridge). Each call takes the next bits of the stream.
export class Generator {
  readonly #bits: BitGenerator;

  constructor(bitGenerator: BitGenerator) {
    this.#bits = bitGenerator;
  }

  // integers(low, high, size): size integers in [low, high), for a range
  // high - low from 1 to 2^32. NumPy draws 64 bits above 2^32, a path this
  // port does not prove. A size of 0 draws nothing and checks no bounds, as
  // _rand_int64 returns before its checks.
  integers(low: number, high: number, size: number): number[] {
    if (size === 0) return [];
    const range = high - low;
    // format_bounds_error: NumPy names high alone when low is 0.
    if (!(range > 0))
      throw new RangeError(low === 0 ? 'high <= 0' : 'low >= high');
    if (range > 2 ** 32)
      throw new RangeError(
        `This port draws ranges of at most 2^32, not ${range}`,
      );
    return Array.from(
      { length: size },
      () => low + this.#boundedUint64(range - 1),
    );
  }

  // random(size): size floats of 53 bits in [0, 1), each the next_double of
  // the bit generator (random_standard_uniform_fill).
  random(size: number): number[] {
    return Array.from({ length: size }, () => this.#bits.nextDouble());
  }

  // shuffle(x) of a list or a 1-D array, in place: from the last index down,
  // each item swaps with the item at random_interval(i).
  shuffle(values: unknown[]): void {
    for (let i = values.length - 1; i >= 1; i--) {
      const j = randomInterval(this.#bits, i);
      [values[i], values[j]] = [values[j], values[i]];
    }
  }

  // permutation(n): a shuffle of arange(n). permutation(values): a shuffle
  // of a copy of values.
  permutation(n: number): number[];
  permutation<T>(values: readonly T[]): T[];
  permutation<T>(x: number | readonly T[]): (number | T)[] {
    const values =
      typeof x === 'number'
        ? Array.from({ length: x }, (_, index) => index)
        : [...x];
    this.shuffle(values);
    return values;
  }

  // choice(a, size): size items of a 1-D array a, or of arange(a) when a is a
  // number, without p. With replacement, NumPy's default, the indices are
  // integers(0, pop_size, size) of int64.
  choice(a: number, size: number, options?: ChoiceOptions): number[];
  choice<T>(a: readonly T[], size: number, options?: ChoiceOptions): T[];
  choice<T>(
    a: number | readonly T[],
    size: number,
    { replace = true }: ChoiceOptions = {},
  ): (number | T)[] {
    const popSize = typeof a === 'number' ? a : a.length;
    if (popSize <= 0 && size !== 0)
      throw new RangeError(
        typeof a === 'number'
          ? 'a must be a positive integer unless no samples are taken'
          : 'a cannot be empty unless no samples are taken',
      );
    const indices = replace
      ? this.integers(0, popSize, size)
      : this.#floyd(popSize, size);
    return typeof a === 'number'
      ? indices
      : indices.map((index) => {
          const item = a[index];
          if (item === undefined) throw new RangeError(`No item at ${index}`);
          return item;
        });
  }

  // Without replacement: Floyd's algorithm draws size distinct indices, and
  // _shuffle_int shuffles them. NumPy shuffles the tail of a permutation for
  // a population above 10,000 and a size above a 50th of it, a path this
  // port does not prove.
  #floyd(popSize: number, size: number): number[] {
    if (size > popSize)
      throw new RangeError(
        'Cannot take a larger sample than population when replace is False',
      );
    if (popSize > 10_000 && size > Math.floor(popSize / 50))
      throw new RangeError(
        "This port chooses without replacement by Floyd's algorithm only",
      );
    const drawn = new Set<number>();
    const indices: number[] = [];
    for (let j = popSize - size; j < popSize; j++) {
      const value = this.#boundedUint64(j);
      const index = drawn.has(value) ? j : value;
      drawn.add(index);
      indices.push(index);
    }
    this.#shuffleInt(indices);
    return indices;
  }

  // _shuffle_int: from the last index down, each item swaps with the item at
  // random_bounded_uint64(0, i).
  #shuffleInt(values: unknown[]): void {
    for (let i = values.length - 1; i >= 1; i--) {
      const j = this.#boundedUint64(i);
      [values[i], values[j]] = [values[j], values[i]];
    }
  }

  // random_bounded_uint64(off=0, rng) for rng below 2^32: no draw for rng 0,
  // else Lemire's method.
  #boundedUint64(rng: number): number {
    return rng === 0 ? 0 : boundedLemire(this.#bits, rng);
  }
}
