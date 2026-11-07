const MASK32 = 0xffff_ffffn;
const POOL_SIZE = 4;
const INIT_A = 0x43b0_d7e5;
const MULT_A = 0x931e_8875;
const INIT_B = 0x8b51_f9dd;
const MULT_B = 0x58f3_8ded;
const MIX_MULT_L = 0xca01_f9dd;
const MIX_MULT_R = 0x4973_f715;

// numpy.random.SeedSequence(seed) without a spawn key: the seed, cut into
// words of 32 bits from the low end, is mixed into a pool of 4 words.
export class SeedSequence {
  readonly #pool: readonly number[];

  constructor(seed: number | bigint) {
    this.#pool = SeedSequence.#mixEntropy(
      SeedSequence.#entropy(SeedSequence.#seedValue(seed)),
    );
  }

  // generate_state(nWords, dtype=np.uint32): nWords words from the pool, in
  // turn.
  generateState(nWords: number): Uint32Array {
    const state = new Uint32Array(nWords);
    let hashConst = INIT_B;
    for (let index = 0; index < nWords; index++) {
      let value = ((this.#pool[index % POOL_SIZE] ?? 0) ^ hashConst) >>> 0;
      hashConst = Math.imul(hashConst, MULT_B) >>> 0;
      value = Math.imul(value, hashConst) >>> 0;
      state[index] = (value ^ (value >>> 16)) >>> 0;
    }
    return state;
  }

  // A seed as NumPy reads it: an int of any size, from 0 up.
  static #seedValue(seed: number | bigint): bigint {
    if (typeof seed === 'number' && !Number.isInteger(seed))
      throw new TypeError(
        `SeedSequence expects int or sequence of ints for entropy not ${seed}`,
      );
    const value = BigInt(seed);
    if (value < 0n) throw new RangeError('expected non-negative integer');
    return value;
  }

  // _coerce_to_uint32_array: the words of 32 bits of the seed, the low word
  // first; the seed 0 is one word.
  static #entropy(seed: bigint): number[] {
    const words: number[] = [];
    let rest = seed;
    do {
      words.push(Number(rest & MASK32));
      rest >>= 32n;
    } while (rest > 0n);
    return words;
  }

  // mix_entropy: each word of the pool takes the hash of each other word,
  // then each word of the entropy past the pool.
  static #mixEntropy(entropy: readonly number[]): number[] {
    let hashConst = INIT_A;
    const hashmix = (value: number) => {
      let mixed = (value ^ hashConst) >>> 0;
      hashConst = Math.imul(hashConst, MULT_A) >>> 0;
      mixed = Math.imul(mixed, hashConst) >>> 0;
      return (mixed ^ (mixed >>> 16)) >>> 0;
    };
    const mix = (x: number, y: number) => {
      const result =
        (Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y)) >>> 0;
      return (result ^ (result >>> 16)) >>> 0;
    };
    const pool = Array.from({ length: POOL_SIZE }, (_, index) =>
      hashmix(entropy[index] ?? 0),
    );
    for (let source = 0; source < POOL_SIZE; source++)
      for (let target = 0; target < POOL_SIZE; target++)
        if (source !== target)
          pool[target] = mix(pool[target] ?? 0, hashmix(pool[source] ?? 0));
    for (let source = POOL_SIZE; source < entropy.length; source++)
      for (let target = 0; target < POOL_SIZE; target++)
        pool[target] = mix(pool[target] ?? 0, hashmix(entropy[source] ?? 0));
    return pool;
  }
}
