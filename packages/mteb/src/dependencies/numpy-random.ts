// numpy.random.default_rng(seed).integers(low, high, size) for a seed and a
// range below 2^32, bit for bit: SeedSequence, PCG64 (XSL-RR) and Lemire's
// bounded integers, as numpy 2 implements them. The paired bootstrap test
// (significance/paired-bootstrap.ts) draws its replicates with it, so a
// verdict is the verdict of the same test in NumPy.

const MASK32 = 0xffff_ffffn;
const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const MULTIPLIER = 0x2360_ed05_1fc6_5da4_4385_df64_9fcc_f645n;

const INIT_A = 0x43b0_d7e5;
const MULT_A = 0x931e_8875;
const INIT_B = 0x8b51_f9dd;
const MULT_B = 0x58f3_8ded;
const MIX_MULT_L = 0xca01_f9dd;
const MIX_MULT_R = 0x4973_f715;
const POOL_SIZE = 4;

// numpy's SeedSequence: the pool of 4 words from the entropy of the seed.
function pool(seed: number): number[] {
  const entropy: number[] = [];
  let rest = BigInt(seed);
  do {
    entropy.push(Number(rest & MASK32));
    rest >>= 32n;
  } while (rest > 0n);
  let hashConst = INIT_A;
  const hashmix = (value: number) => {
    let mixed = (value ^ hashConst) >>> 0;
    hashConst = Math.imul(hashConst, MULT_A) >>> 0;
    mixed = Math.imul(mixed, hashConst) >>> 0;
    return (mixed ^ (mixed >>> 16)) >>> 0;
  };
  const mix = (x: number, y: number) => {
    const result = (Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y)) >>> 0;
    return (result ^ (result >>> 16)) >>> 0;
  };
  const words = Array.from({ length: POOL_SIZE }, (_, index) =>
    hashmix(entropy[index] ?? 0),
  );
  for (let source = 0; source < POOL_SIZE; source++)
    for (let target = 0; target < POOL_SIZE; target++)
      if (source !== target)
        words[target] = mix(words[target] ?? 0, hashmix(words[source] ?? 0));
  for (let source = POOL_SIZE; source < entropy.length; source++)
    for (let target = 0; target < POOL_SIZE; target++)
      words[target] = mix(words[target] ?? 0, hashmix(entropy[source] ?? 0));
  return words;
}

// SeedSequence.generate_state(4, uint64): 8 words of 32 bits, read as 4
// little-endian words of 64 bits.
function state(seed: number): bigint[] {
  const words = pool(seed);
  let hashConst = INIT_B;
  const out: number[] = [];
  for (let index = 0; index < 8; index++) {
    let value = ((words[index % POOL_SIZE] ?? 0) ^ hashConst) >>> 0;
    hashConst = Math.imul(hashConst, MULT_B) >>> 0;
    value = Math.imul(value, hashConst) >>> 0;
    out.push((value ^ (value >>> 16)) >>> 0);
  }
  return [0, 2, 4, 6].map(
    (index) => (BigInt(out[index + 1] ?? 0) << 32n) | BigInt(out[index] ?? 0),
  );
}

export class NumpyGenerator {
  #state: bigint;
  readonly #increment: bigint;
  // The high half of the last 64-bit output, which the next 32-bit draw
  // takes, as numpy buffers it.
  readonly #halves: number[] = [];

  constructor(seed: number) {
    const [s0 = 0n, s1 = 0n, i0 = 0n, i1 = 0n] = state(seed);
    this.#increment = ((((i0 << 64n) | i1) << 1n) | 1n) & MASK128;
    this.#state = 0n;
    this.#step();
    this.#state = (this.#state + ((s0 << 64n) | s1)) & MASK128;
    this.#step();
  }

  // integers(low, high, size): size integers in [low, high).
  integers(low: number, high: number, size: number): number[] {
    const range = high - low - 1;
    return Array.from({ length: size }, () =>
      range === 0 ? low : low + this.#bounded(range),
    );
  }

  // buffered_bounded_lemire_uint32: an integer in [0, range].
  #bounded(range: number): number {
    const exclusive = BigInt(range) + 1n;
    let m = BigInt(this.#next32()) * exclusive;
    let leftover = m & MASK32;
    if (leftover < exclusive) {
      const threshold = (MASK32 - BigInt(range)) % exclusive;
      while (leftover < threshold) {
        m = BigInt(this.#next32()) * exclusive;
        leftover = m & MASK32;
      }
    }
    return Number(m >> 32n);
  }

  #next32(): number {
    const half = this.#halves.pop();
    if (half !== undefined) return half;
    const next = this.#next64();
    this.#halves.push(Number(next >> 32n));
    return Number(next & MASK32);
  }

  #next64(): bigint {
    this.#step();
    const high = this.#state >> 64n;
    const low = this.#state & MASK64;
    const value = high ^ low;
    const rotation = high >> 58n;
    return ((value >> rotation) | (value << ((64n - rotation) & 63n))) & MASK64;
  }

  #step(): void {
    this.#state = (this.#state * MULTIPLIER + this.#increment) & MASK128;
  }
}

// numpy.random.RandomState(seed), the legacy generator that
// sklearn.utils.check_random_state(seed) gives: MT19937 seeded by
// init_genrand (mt19937_seed of numpy/random/src/mt19937/mt19937.c), and the
// draws of mtrand.pyx that scikit-learn's MiniBatchKMeans calls. CPython's
// random.Random (python-random.ts) has its own copy of the generator: it
// seeds with init_by_array.
const MT_N = 624;
const MT_M = 397;
const MATRIX_A = 0x9908_b0df;
const UPPER_MASK = 0x8000_0000;
const LOWER_MASK = 0x7fff_ffff;

export class RandomState {
  readonly #key = new Uint32Array(MT_N);
  #pos = MT_N;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)
      throw new RangeError('Seed must be between 0 and 2**32 - 1');
    let value = seed >>> 0;
    for (let pos = 0; pos < MT_N; pos++) {
      this.#key[pos] = value;
      value =
        (Math.imul(1_812_433_253, value ^ (value >>> 30)) + pos + 1) >>> 0;
    }
  }

  // random_sample(size): size floats in [0, 1) of 53 bits.
  randomSample(size: number): number[] {
    return Array.from({ length: size }, () => this.#nextDouble());
  }

  // uniform(size=size), with low 0 and high 1: low + (high - low) *
  // random_sample(). numpy's C code can fuse the multiply and the add (an
  // FMA on arm64); with 0 and 1 both give random_sample().
  uniform(size: number): number[] {
    return this.randomSample(size);
  }

  // randint(low, high, size) of int64 for a range below 2^32: masked
  // rejection sampling with 32-bit draws (random_bounded_uint64_fill with
  // use_masked).
  randint(low: number, high: number, size: number): number[] {
    const range = high - low - 1;
    if (range < 0) throw new RangeError('low >= high');
    if (range > 0xffff_ffff)
      throw new RangeError('This port draws ranges below 2^32 only.');
    if (range === 0) return new Array<number>(size).fill(low);
    if (range === 0xffff_ffff)
      return Array.from({ length: size }, () => low + this.#next32());
    const mask = smallestMask(range);
    return Array.from({ length: size }, () => {
      let value = (this.#next32() & mask) >>> 0;
      while (value > range) value = (this.#next32() & mask) >>> 0;
      return low + value;
    });
  }

  // choice(n, size, p=p) with replace=True: the cumulative sum of p in
  // float64, divided by its last value, searched on the right for each
  // random_sample.
  choiceWithProbabilities(p: ArrayLike<number>, size: number): number[] {
    const cdf = new Float64Array(p.length);
    let total = 0;
    for (let index = 0; index < p.length; index++) {
      total += p[index] ?? 0;
      cdf[index] = total;
    }
    const last = cdf[cdf.length - 1] ?? 1;
    for (let index = 0; index < cdf.length; index++)
      cdf[index] = (cdf[index] ?? 0) / last;
    return this.randomSample(size).map((value) =>
      searchsortedRight(cdf, value),
    );
  }

  // choice(n, size, replace=False) without p: permutation(n)[:size].
  choiceWithoutReplacement(n: number, size: number): number[] {
    if (size > n)
      throw new RangeError(
        "Cannot take a larger sample than population when 'replace=False'",
      );
    return this.permutation(n).slice(0, size);
  }

  // permutation(n): shuffle of arange(n), from the last index down, each
  // swap with random_interval(i).
  permutation(n: number): number[] {
    const values = Array.from({ length: n }, (_, index) => index);
    for (let i = n - 1; i >= 1; i--) {
      const j = this.#interval(i);
      const swapped = values[j] ?? 0;
      values[j] = values[i] ?? 0;
      values[i] = swapped;
    }
    return values;
  }

  // random_interval(max): an integer in [0, max] by masked rejection.
  #interval(max: number): number {
    if (max === 0) return 0;
    if (max > 0xffff_ffff)
      throw new RangeError('This port draws intervals below 2^32 only.');
    const mask = smallestMask(max);
    let value = (this.#next32() & mask) >>> 0;
    while (value > max) value = (this.#next32() & mask) >>> 0;
    return value;
  }

  #nextDouble(): number {
    const a = this.#next32() >>> 5;
    const b = this.#next32() >>> 6;
    return (a * 67_108_864 + b) / 9_007_199_254_740_992;
  }

  #next32(): number {
    const key = this.#key;
    if (this.#pos === MT_N) {
      const twist = (i: number, next: number, source: number) => {
        const y =
          ((key[i] ?? 0) & UPPER_MASK) | ((key[next] ?? 0) & LOWER_MASK);
        key[i] = (key[source] ?? 0) ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      };
      let i = 0;
      for (; i < MT_N - MT_M; i++) twist(i, i + 1, i + MT_M);
      for (; i < MT_N - 1; i++) twist(i, i + 1, i + (MT_M - MT_N));
      twist(MT_N - 1, 0, MT_M - 1);
      this.#pos = 0;
    }
    let y = key[this.#pos++] ?? 0;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c_5680;
    y ^= (y << 15) & 0xefc6_0000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

// The smallest mask of ones that covers max.
function smallestMask(max: number): number {
  return max >= 0x8000_0000 ? 0xffff_ffff : 2 ** (32 - Math.clz32(max)) - 1;
}

// np.searchsorted(sorted, value, side="right").
function searchsortedRight(sorted: ArrayLike<number>, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? 0) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}
