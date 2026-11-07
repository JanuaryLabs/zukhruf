import { type JsonData, compareStrings, floatRepr } from '@zukhruf/python';

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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Map)
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
