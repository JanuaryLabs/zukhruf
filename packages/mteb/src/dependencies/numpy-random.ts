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
