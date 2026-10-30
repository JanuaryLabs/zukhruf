// The CPython 3.12 algorithms whose results MTEB depends on.

// sum() of floats. CPython 3.12 adds with Neumaier's compensated summation
// (Neumaier 1974), so the result can differ from a plain loop in the last
// bit.
export function pythonSum(values: Iterable<number>): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const total = sum + value;
    compensation +=
      Math.abs(sum) >= Math.abs(value)
        ? sum - total + value
        : value - total + sum;
    sum = total;
  }
  return compensation !== 0 && Number.isFinite(compensation)
    ? sum + compensation
    : sum;
}

// round(value, digits). CPython rounds the exact binary value of the float to
// the nearest decimal with the given digits, a tie to the even digit, and
// returns the float nearest to that decimal.
export function pythonRound(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const [mantissa, exponent] = exactBinary(Math.abs(value));
  const scaled = mantissa * 10n ** BigInt(digits);
  let rounded: bigint;
  if (exponent >= 0) rounded = scaled << BigInt(exponent);
  else {
    const divisor = 1n << BigInt(-exponent);
    const quotient = scaled / divisor;
    const twiceRemainder = (scaled % divisor) * 2n;
    rounded =
      twiceRemainder > divisor ||
      (twiceRemainder === divisor && quotient % 2n === 1n)
        ? quotient + 1n
        : quotient;
  }
  const result = Number(`${rounded}e-${digits}`);
  return value < 0 ? -result : result;
}

// round(value) of a float: the nearest integer, a tie to the even one.
export function pythonRoundToInteger(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// Compares two strings as Python does: by Unicode code point. UTF-8 bytes,
// which C's strcmp compares, have the same order.
export function compareStrings(left: string, right: string): number {
  if (!SURROGATE.test(left) && !SURROGATE.test(right))
    return left < right ? -1 : left > right ? 1 : 0;
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference =
      (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

// UTF-16 code units order the strings that have no character above U+FFFF
// as code points do.
const SURROGATE = /[\u{10000}-\u{10FFFF}]/u;

// A (score, id) tuple. Python compares tuples item by item.
export type ScoredId = readonly [score: number, id: string];

export function compareScoredIds(left: ScoredId, right: ScoredId): number {
  if (left[0] < right[0]) return -1;
  if (left[0] > right[0]) return 1;
  return compareStrings(left[1], right[1]);
}

// sorted(scores.items(), key=lambda item: (item[1], item[0]), reverse=True):
// the best score first, and of equal scores the greatest id first.
export function rankByScore(
  scores: ReadonlyMap<string, number>,
): [id: string, score: number][] {
  return [...scores]
    .map(([id, score]): ScoredId => [score, id])
    .sort((left, right) => compareScoredIds(right, left))
    .map(([score, id]) => [id, score]);
}

// The exact value of a positive finite double: mantissa * 2^exponent.
function exactBinary(value: number): [mantissa: bigint, exponent: number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  return biased === 0
    ? [fraction, -1074]
    : [fraction | (1n << 52n), biased - 1075];
}

// isinstance(value, dict): an object that is not an array, a Map, a Date or another class instance.
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// repr(float): the shortest digits that read back as the same float, in
// positional notation when the exponent is from -4 to 15, else in scientific
// notation with at least two exponent digits.
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const [mantissa = '', exponentText = '0'] = value.toExponential().split('e');
  const sign = mantissa.startsWith('-') || Object.is(value, -0) ? '-' : '';
  const digits = mantissa.replace('-', '').replace('.', '');
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.slice(1);
    const magnitude = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${digits[0]}${fraction ? `.${fraction}` : ''}e${exponent < 0 ? '-' : '+'}${magnitude}`;
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}.${fraction || '0'}`;
}
