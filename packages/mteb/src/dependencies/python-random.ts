import { log } from './libm.ts';

// random.Random(seed) of CPython 3.12 (Lib/random.py and
// Modules/_randommodule.c) for an int seed: the Mersenne Twister MT19937
// seeded by init_by_array with the 32-bit words of |seed|, and the methods
// that MTEB calls, with the same draws. numpy's legacy RandomState
// (numpy-random.ts) has its own copy of the generator: it seeds with
// init_genrand, not init_by_array.

const N = 624;
const M = 397;
const MATRIX_A = 0x9908_b0df;
const UPPER_MASK = 0x8000_0000;
const LOWER_MASK = 0x7fff_ffff;

export class PythonRandom {
  readonly #state = new Uint32Array(N);
  #index = N;

  constructor(seed: number) {
    this.#initByArray(seedKey(seed));
  }

  // random(): a float in [0, 1) from 53 random bits.
  random(): number {
    const a = this.#genrandUint32() >>> 5;
    const b = this.#genrandUint32() >>> 6;
    return (a * 67_108_864 + b) * (1 / 9_007_199_254_740_992);
  }

  // getrandbits(k) for k up to 32.
  getrandbits(k: number): number {
    if (k < 0) throw new RangeError('number of bits must be non-negative');
    if (k === 0) return 0;
    if (k > 32)
      throw new RangeError(
        `getrandbits(${k}): this port draws at most 32 bits.`,
      );
    return this.#genrandUint32() >>> (32 - k);
  }

  // sample(range(n), k): k distinct ints of [0, n). A small population is
  // drawn from a pool; a large one by rejection of the ints already
  // selected.
  sample(n: number, k: number): number[] {
    if (!(k >= 0 && k <= n))
      throw new RangeError('Sample larger than population or is negative');
    const result: number[] = [];
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(log(k * 3) / log(4));
    if (n <= setsize) {
      const pool = Array.from({ length: n }, (_, index) => index);
      for (let i = 0; i < k; i++) {
        const j = this.#randbelow(n - i);
        result.push(pool[j] ?? j);
        pool[j] = pool[n - i - 1] ?? n - i - 1;
      }
      return result;
    }
    const selected = new Set<number>();
    for (let i = 0; i < k; i++) {
      let j = this.#randbelow(n);
      while (selected.has(j)) j = this.#randbelow(n);
      selected.add(j);
      result.push(j);
    }
    return result;
  }

  // choices(range(n), k=k) without weights: k ints of [0, n) with
  // replacement.
  choices(n: number, k: number): number[] {
    return Array.from({ length: k }, () => Math.floor(this.random() * n));
  }

  // _randbelow_with_getrandbits(n): an int in [0, n), for n > 0.
  #randbelow(n: number): number {
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  #initGenrand(s: number): void {
    const mt = this.#state;
    mt[0] = s;
    for (let i = 1; i < N; i++) {
      const previous = mt[i - 1] ?? 0;
      mt[i] = Math.imul(1_812_433_253, previous ^ (previous >>> 30)) + i;
    }
    this.#index = N;
  }

  #initByArray(key: readonly number[]): void {
    this.#initGenrand(19_650_218);
    const mt = this.#state;
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const previous = mt[i - 1] ?? 0;
      mt[i] =
        ((mt[i] ?? 0) ^ Math.imul(previous ^ (previous >>> 30), 1_664_525)) +
        (key[j] ?? 0) +
        j;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1] ?? 0;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const previous = mt[i - 1] ?? 0;
      mt[i] =
        ((mt[i] ?? 0) ^
          Math.imul(previous ^ (previous >>> 30), 1_566_083_941)) -
        i;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1] ?? 0;
        i = 1;
      }
    }
    mt[0] = 0x8000_0000;
  }

  #genrandUint32(): number {
    const mt = this.#state;
    if (this.#index >= N) {
      const twist = (kk: number, next: number, source: number) => {
        const y = ((mt[kk] ?? 0) & UPPER_MASK) | ((mt[next] ?? 0) & LOWER_MASK);
        mt[kk] = (mt[source] ?? 0) ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      };
      let kk = 0;
      for (; kk < N - M; kk++) twist(kk, kk + 1, kk + M);
      for (; kk < N - 1; kk++) twist(kk, kk + 1, kk + (M - N));
      twist(N - 1, 0, M - 1);
      this.#index = 0;
    }
    let y = mt[this.#index++] ?? 0;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c_5680;
    y ^= (y << 15) & 0xefc6_0000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

// The 32-bit words of |seed|, from the least significant; 0 gives [0].
function seedKey(seed: number): number[] {
  if (!Number.isSafeInteger(seed))
    throw new TypeError(`A seed must be an integer, not ${seed}.`);
  let rest = BigInt(Math.abs(seed));
  const key: number[] = [];
  do {
    key.push(Number(rest & 0xffff_ffffn));
    rest >>= 32n;
  } while (rest > 0n);
  return key;
}

function bitLength(n: number): number {
  return n === 0 ? 0 : 32 - Math.clz32(n);
}
