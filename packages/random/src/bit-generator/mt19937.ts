import type { BitGenerator } from './bit-generator.ts';

const N = 624;
const M = 397;
const MATRIX_A = 0x9908_b0df;
const UPPER_MASK = 0x8000_0000;
const LOWER_MASK = 0x7fff_ffff;

// numpy.random.MT19937, the Mersenne Twister of RandomState.
export class MT19937 implements BitGenerator {
  readonly #key = new Uint32Array(N);
  #pos = N;

  private constructor(seed: number) {
    let value = seed;
    for (let pos = 0; pos < N; pos++) {
      this.#key[pos] = value;
      value =
        (Math.imul(1_812_433_253, value ^ (value >>> 30)) + pos + 1) >>> 0;
    }
  }

  // MT19937._legacy_seeding(seed), as RandomState(seed) seeds it:
  // init_genrand of a seed from 0 to 2^32 - 1.
  static legacy(seed: number | bigint): MT19937 {
    if (typeof seed === 'number' && !Number.isInteger(seed))
      throw new TypeError(`A seed is an integer, not ${seed}`);
    const value = BigInt(seed);
    if (value < 0n || value > 0xffff_ffffn)
      throw new RangeError('Seed must be between 0 and 2**32 - 1');
    return new MT19937(Number(value));
  }

  nextUint32(): number {
    if (this.#pos === N) this.#twist();
    let y = this.#key[this.#pos++] ?? 0;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c_5680;
    y ^= (y << 15) & 0xefc6_0000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  // mt19937_next_double: a float of 53 bits in [0, 1) from two words.
  nextDouble(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67_108_864 + b) / 9_007_199_254_740_992;
  }

  #twist(): void {
    const key = this.#key;
    const twist = (i: number, next: number, source: number) => {
      const y = ((key[i] ?? 0) & UPPER_MASK) | ((key[next] ?? 0) & LOWER_MASK);
      key[i] = (key[source] ?? 0) ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
    };
    let i = 0;
    for (; i < N - M; i++) twist(i, i + 1, i + M);
    for (; i < N - 1; i++) twist(i, i + 1, i + (M - N));
    twist(N - 1, 0, M - 1);
    this.#pos = 0;
  }
}
