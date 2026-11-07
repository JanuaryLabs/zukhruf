import type { BitGenerator } from '../bit-generator/bit-generator.ts';

// random_interval(max) of distributions.c: an integer in [0, max] by masked
// rejection on 32-bit draws, for a max below 2^32. The shuffles of Generator
// and RandomState and the randint of RandomState draw with it.
export function randomInterval(bits: BitGenerator, max: number): number {
  if (max === 0) return 0;
  const mask =
    max >= 0x8000_0000 ? 0xffff_ffff : 2 ** (32 - Math.clz32(max)) - 1;
  let value = (bits.nextUint32() & mask) >>> 0;
  while (value > max) value = (bits.nextUint32() & mask) >>> 0;
  return value;
}
