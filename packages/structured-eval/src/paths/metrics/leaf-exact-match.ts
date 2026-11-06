import type { JsonData } from '@zukhruf/python';

import type { JsonPair } from '../json-pair.ts';
import { LeafMean } from './leaf-mean.ts';

// The expected leaves whose path the stated value has with an equal value
// (Python ==), of all expected leaves, and whenNoneExpected when the expected
// value has no leaf (exact_match_ratio gives 1).
export class LeafExactMatch extends LeafMean {
  constructor({ whenNoneExpected }: { readonly whenNoneExpected: number }) {
    super(whenNoneExpected);
  }

  protected leaves({
    expectedLeaves,
  }: JsonPair): ReadonlyMap<string, JsonData> {
    return expectedLeaves;
  }

  protected leafValue(
    path: string,
    value: JsonData,
    { statedLeaves }: JsonPair,
  ): number {
    const stated = statedLeaves.get(path);
    return stated !== undefined && LeafExactMatch.#pythonEquals(value, stated)
      ? 1
      : 0;
  }

  // Python's == for the leaf values of a record: bool, int and float compare
  // as numbers (True == 1 == 1.0), exactly; a str equals a str; None equals
  // None. A leaf is never a list or a dict (flatten_leaf_paths).
  static #pythonEquals(left: JsonData, right: JsonData): boolean {
    const a = LeafExactMatch.#asNumber(left);
    const b = LeafExactMatch.#asNumber(right);
    if (typeof a === 'bigint' && typeof b === 'number')
      return LeafExactMatch.#intIsFloat(a, b);
    if (typeof a === 'number' && typeof b === 'bigint')
      return LeafExactMatch.#intIsFloat(b, a);
    if (a !== undefined && b !== undefined) return a === b;
    return left === right;
  }

  static #asNumber(value: JsonData): bigint | number | undefined {
    if (typeof value === 'boolean') return value ? 1n : 0n;
    if (typeof value === 'bigint' || typeof value === 'number') return value;
    return undefined;
  }

  // An int equals a float when the float is integral and has the same value,
  // exactly, as Python compares them.
  static #intIsFloat(int: bigint, float: number): boolean {
    return Number.isInteger(float) && BigInt(float) === int;
  }
}
