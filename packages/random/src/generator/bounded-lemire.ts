import type { BitGenerator } from '../bit-generator/bit-generator.ts';

const MASK32 = 0xffff_ffffn;

// buffered_bounded_lemire_uint32 of distributions.c: an integer in
// [0, range] by Lemire's method, for a range from 1 to 2^32 - 1.
export function boundedLemire(bits: BitGenerator, range: number): number {
  const exclusive = BigInt(range) + 1n;
  let m = BigInt(bits.nextUint32()) * exclusive;
  let leftover = m & MASK32;
  if (leftover < exclusive) {
    const threshold = (MASK32 - BigInt(range)) % exclusive;
    while (leftover < threshold) {
      m = BigInt(bits.nextUint32()) * exclusive;
      leftover = m & MASK32;
    }
  }
  return Number(m >> 32n);
}
