import { type JsonData, floatRepr } from '@zukhruf/python';

import { isDict, isList } from '../json-value.ts';

// UTF-16 code units order the strings that have no character above U+FFFF
// as code points do.
const SURROGATE = /[\u{10000}-\u{10FFFF}]/u;

// Compares two strings as Python does: by Unicode code point. Copied from
// @zukhruf/mteb compareStrings (docs/copied-code.md).
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

// The escapes of json.dumps with ensure_ascii=False (ESCAPE and ESCAPE_DCT,
// Lib/json/encoder.py): the quote, the backslash and the control characters.
const escapes: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

const jsonString = (text: string) => {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    out +=
      escapes[char] ??
      (code < 0x20 ? `\x5Cu${code.toString(16).padStart(4, '0')}` : char);
  }
  return `"${out}"`;
};

const jsonFloat = (value: number) => {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return floatRepr(value);
};

// json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
// of CPython: the canonical text that evaluate.py compares for a perfect
// response.
export function canonicalJson(value: JsonData): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return jsonFloat(value);
  if (typeof value === 'string') return jsonString(value);
  if (isList(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isDict(value))
    return `{${[...value]
      .toSorted(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${jsonString(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  throw new TypeError(
    'A Python value is null, bool, int, float, str, list or dict',
  );
}

// str() of a scalar: an int as its digits, a float as its repr, a str as it
// is. None and bool are named by the caller, as evaluate.py does.
export function pythonStr(value: bigint | number | string): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return floatRepr(value);
  return value;
}
