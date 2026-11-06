import type { JsonData } from '@zukhruf/python';

const asNumber = (value: JsonData): bigint | number | undefined => {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'bigint' || typeof value === 'number') return value;
  return undefined;
};

// An int equals a float when the float is integral and has the same value,
// exactly, as Python compares them.
const intIsFloat = (int: bigint, float: number) =>
  Number.isInteger(float) && BigInt(float) === int;

// Python's == for the leaf values of a record: bool, int and float compare as
// numbers (True == 1 == 1.0), exactly; a str equals a str; None equals None.
// A leaf is never a list or a dict (flatten_leaf_paths).
export function pythonEquals(left: JsonData, right: JsonData): boolean {
  const a = asNumber(left);
  const b = asNumber(right);
  if (typeof a === 'bigint' && typeof b === 'number') return intIsFloat(a, b);
  if (typeof a === 'number' && typeof b === 'bigint') return intIsFloat(b, a);
  if (a !== undefined && b !== undefined) return a === b;
  return left === right;
}
