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

// The message of the ValueError of zip(*iterables, strict=True) for
// iterables of these lengths, or null when the lengths are equal. CPython
// names the first argument after the first that is shorter or longer than
// the arguments before it.
export function zipStrictMismatch(lengths: readonly number[]): string | null {
  const [first = 0, ...rest] = lengths;
  const shortest = Math.min(first, ...rest);
  const shorter = rest.findIndex((length) => length === shortest) + 1;
  const longer = rest.findIndex((length) => length > shortest) + 1;
  const [index, relation] =
    first > shortest ? [shorter, 'shorter'] : [longer, 'longer'];
  if (index === 0) return null;
  const before = index === 1 ? ' 1' : `s 1-${index}`;
  return `zip() argument ${index + 1} is ${relation} than argument${before}`;
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

// format(value, '.<digits>f'): the exact binary value of the float rounded to
// the given decimals, a tie to the even digit, as CPython's dtoa rounds.
// toFixed rounds a tie up and writes 1e21 and above in scientific notation.
export function pythonFormatFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const scaled = value === 0 ? 0n : scaledHalfEven(Math.abs(value), digits);
  const text = String(scaled).padStart(digits + 1, '0');
  return digits === 0
    ? `${sign}${text}`
    : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

// format(value, 'g'): 6 significant digits, rounded as pythonFormatFixed
// rounds, in positional notation when the decimal exponent is from -4 to 5,
// else in scientific notation with at least two exponent digits; trailing
// zeros and a trailing point are removed.
export function pythonFormatG(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  if (value === 0) return `${sign}0`;
  const magnitude = Math.abs(value);
  let exponent = Number(magnitude.toExponential().split('e')[1]);
  let scaled = scaledHalfEven(magnitude, 5 - exponent);
  while (scaled >= 1_000_000n)
    scaled = scaledHalfEven(magnitude, 5 - ++exponent);
  while (scaled < 100_000n) scaled = scaledHalfEven(magnitude, 5 - --exponent);
  const digits = String(scaled);
  const point = (whole: string, fraction: string) => {
    const kept = fraction.replace(/0+$/, '');
    return kept === '' ? whole : `${whole}.${kept}`;
  };
  if (exponent < -4 || exponent >= 6) {
    const magnitudeText = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${point(digits.slice(0, 1), digits.slice(1))}e${exponent < 0 ? '-' : '+'}${magnitudeText}`;
  }
  if (exponent < 0)
    return `${sign}${point('0', `${'0'.repeat(-exponent - 1)}${digits}`)}`;
  return `${sign}${point(digits.slice(0, exponent + 1), digits.slice(exponent + 1))}`;
}

// round(value * 10^power) of a positive finite double, a tie to the even
// integer, on the exact binary value.
function scaledHalfEven(value: number, power: number): bigint {
  const [mantissa, exponent] = exactBinary(value);
  let numerator = mantissa;
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  if (power >= 0) numerator *= 10n ** BigInt(power);
  else denominator *= 10n ** BigInt(-power);
  const quotient = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  return twiceRemainder > denominator ||
    (twiceRemainder === denominator && quotient % 2n === 1n)
    ? quotient + 1n
    : quotient;
}

// repr(text): single quotes, or double quotes when the text has a single
// quote and no double quote; a backslash, the quote, \t, \n and \r escaped;
// other ASCII control characters as \xhh, and the characters that
// str.isprintable() rejects as \xhh, \uhhhh or \Uhhhhhhhh.
export function pythonStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let body = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === quote || char === '\\') body += `\\${char}`;
    else if (char === '\t') body += '\\t';
    else if (char === '\n') body += '\\n';
    else if (char === '\r') body += '\\r';
    else if (code < 0x20 || code === 0x7f)
      body += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (code < 0x7f || !NOT_PRINTABLE.test(char)) body += char;
    else if (code <= 0xff) body += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (code <= 0xffff) body += `\\u${code.toString(16).padStart(4, '0')}`;
    else body += `\\U${code.toString(16).padStart(8, '0')}`;
  }
  return `${quote}${body}${quote}`;
}

// The characters that str.isprintable() rejects: the Unicode categories Cc,
// Cf, Cs, Co, Cn, Zl, Zp and Zs, but the space.
const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

// The characters of str.isspace(), which str.strip(), int() and float() strip.
const PYTHON_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYTHON_STRIP = new RegExp(
  `^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`,
  'gu',
);

// text.strip().
export function pythonStrip(text: string): string {
  return text.replace(PYTHON_STRIP, '');
}

// text.splitlines(): split at \r\n and at each of \n, \r, \v, \f, \x1c,
// \x1d, \x1e, \x85, U+2028 and U+2029, without an empty last line.
export function pythonSplitlines(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (!LINE_BREAKS.has(char)) {
      line += char;
      continue;
    }
    if (char === '\r' && text[index + 1] === '\n') index += 1;
    lines.push(line);
    line = '';
  }
  if (line !== '') lines.push(line);
  return lines;
}

const LINE_BREAKS = new Set(
  String.fromCodePoint(
    0x0a,
    0x0b,
    0x0c,
    0x0d,
    0x1c,
    0x1d,
    0x1e,
    0x85,
    0x2028,
    0x2029,
  ),
);

// A run of Unicode decimal digits, with one underscore between two digits.
const DIGIT_PART = String.raw`\p{Nd}(?:_?\p{Nd})*`;
const PYTHON_INT = new RegExp(
  `^[${PYTHON_SPACE}]*[+-]?${DIGIT_PART}[${PYTHON_SPACE}]*$`,
  'u',
);
const PYTHON_FLOAT = new RegExp(
  `^[${PYTHON_SPACE}]*([+-]?(?:(?:${DIGIT_PART}(?:\\.(?:${DIGIT_PART})?)?|\\.${DIGIT_PART})(?:[eE][+-]?${DIGIT_PART})?|inf(?:inity)?|nan))[${PYTHON_SPACE}]*$`,
  'iu',
);

// Whether int(text) reads the text: base 10, Unicode digits, an underscore
// between two digits, whitespace around.
export function pythonIsInt(text: string): boolean {
  return PYTHON_INT.test(text);
}

// float(text), or undefined where float raises ValueError.
export function pythonFloat(text: string): number | undefined {
  const literal = PYTHON_FLOAT.exec(text)?.[1];
  if (literal === undefined) return undefined;
  const lower = literal.toLowerCase();
  const negative = lower.startsWith('-');
  if (lower.endsWith('inf') || lower.endsWith('infinity'))
    return negative ? -Infinity : Infinity;
  if (lower.endsWith('nan')) return NaN;
  return Number(asciiDigits(literal).replaceAll('_', ''));
}

// Each Unicode decimal digit as its ASCII digit. The digits of a script are
// ten consecutive code points from 0 to 9, and runs of them can follow each
// other, as the mathematical digits do.
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    let start = code;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((code - start) % 10);
  });
}
