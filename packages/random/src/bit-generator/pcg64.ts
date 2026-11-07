import { SeedSequence } from '../seed/seed-sequence.ts';
import type { BitGenerator } from './bit-generator.ts';

const MASK32 = 0xffff_ffffn;
const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const MULTIPLIER = 0x2360_ed05_1fc6_5da4_4385_df64_9fcc_f645n;

// numpy.random.PCG64: a 128-bit LCG with the XSL-RR output of 64 bits.
export class PCG64 implements BitGenerator {
  #state = 0n;
  readonly #increment: bigint;
  // The high half of the last 64-bit output, which the next 32-bit call
  // takes, as NumPy keeps it in the bit generator.
  readonly #halves: number[] = [];

  constructor(seed: number | bigint | SeedSequence) {
    const sequence =
      seed instanceof SeedSequence ? seed : new SeedSequence(seed);
    // generate_state(4, np.uint64): 8 words of 32 bits, read as 4 words of
    // 64 bits, the low word first.
    const words = sequence.generateState(8);
    const [s0, s1, i0, i1] = [0, 2, 4, 6].map(
      (index) =>
        (BigInt(words[index + 1] ?? 0) << 32n) | BigInt(words[index] ?? 0),
    );
    // pcg_setseq_128_srandom_r.
    this.#increment =
      (((((i0 ?? 0n) << 64n) | (i1 ?? 0n)) << 1n) | 1n) & MASK128;
    this.#step();
    this.#state = (this.#state + (((s0 ?? 0n) << 64n) | (s1 ?? 0n))) & MASK128;
    this.#step();
  }

  nextUint32(): number {
    const half = this.#halves.pop();
    if (half !== undefined) return half;
    const next = this.#next64();
    this.#halves.push(Number(next >> 32n));
    return Number(next & MASK32);
  }

  #next64(): bigint {
    this.#step();
    const high = this.#state >> 64n;
    const value = high ^ (this.#state & MASK64);
    const rotation = high >> 58n;
    return ((value >> rotation) | (value << ((64n - rotation) & 63n))) & MASK64;
  }

  #step(): void {
    this.#state = (this.#state * MULTIPLIER + this.#increment) & MASK128;
  }
}
