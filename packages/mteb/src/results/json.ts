import { isPlainObject, pythonFloatRepr } from '../dependencies/python.ts';

// The JSON of MTEB's files. MTEB writes a TaskResult, model_meta.json and
// run_settings.jsonl with Python's json module, and a ModelResult and a
// BenchmarkResults with pydantic's model_dump_json. The two differ: the json
// module writes NaN and Infinity as bare tokens and escapes every character
// outside ASCII; pydantic writes NaN as null and keeps the characters.
//
// A TypeScript number does not say whether Python held an int or a float, so
// an integral number is written as an int: Python writes 1.0, this module 1.
// Python reads both back as the same number.

// json.dumps(value, indent=indent, default=default). Without an indent, the
// separators are ", " and ": ", as Python's defaults. A value that JSON has
// no form for goes through default, as in Python: MTEB passes str. A Map is
// a dict; undefined members of an object are left out.
export function pythonJsonDumps(
  value: unknown,
  options: {
    readonly indent?: number;
    readonly default?: (value: unknown) => unknown;
  } = {},
): string {
  return pythonValue(value, options.indent ?? null, 0, options.default);
}

function pythonValue(
  value: unknown,
  indent: number | null,
  depth: number,
  fallback: ((value: unknown) => unknown) | undefined,
): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return pythonNumber(value);
  if (typeof value === 'string') return pythonString(value);
  const items = itemsOf(value);
  if (items === null) {
    if (fallback === undefined)
      throw new TypeError(
        `Object of type ${typeName(value)} is not JSON serializable`,
      );
    return pythonValue(fallback(value), indent, depth, undefined);
  }
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (items.length === 0) return `${open}${close}`;
  const parts = items.map(
    ([key, item]) =>
      `${key === null ? '' : `${pythonString(key)}: `}${pythonValue(item, indent, depth + 1, fallback)}`,
  );
  if (indent === null) return `${open}${parts.join(', ')}${close}`;
  const inner = '\n' + ' '.repeat(indent * (depth + 1));
  const outer = '\n' + ' '.repeat(indent * depth);
  return `${open}${inner}${parts.join(`,${inner}`)}${outer}${close}`;
}

// The items of a list or a dict, or null for a value that JSON has no form
// for.
function itemsOf(value: unknown): [string | null, unknown][] | null {
  if (Array.isArray(value))
    return value.map((item: unknown): [null, unknown] => [null, item]);
  if (value instanceof Map)
    return [...value.entries()].map(
      ([key, item]: [unknown, unknown]): [string, unknown] => [
        String(key),
        item,
      ],
    );
  if (!isPlainObject(value)) return null;
  return Object.entries(value).flatMap(([key, item]): [string, unknown][] =>
    item === undefined ? [] : [[key, item]],
  );
}

function typeName(value: unknown): string {
  if (value instanceof Date) return 'datetime';
  if (typeof value === 'object' && value !== null)
    return value.constructor.name;
  return typeof value;
}

// float.__repr__ for a float, str(int) for an integral number.
function pythonNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Number.isSafeInteger(value) && !Object.is(value, -0))
    return String(value);
  return pythonFloatRepr(value);
}

// A JSON string as Python writes it with ensure_ascii: every character
// outside the printable ASCII range is a \u escape.
function pythonString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const char = value[index] ?? '';
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e)
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

// model_dump_json(indent=2): NaN and the infinities are null, a Date is an
// ISO string, and the characters stay as they are.
export function pydanticJsonDumps(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) =>
      item instanceof Map ? Object.fromEntries(item) : item,
    2,
  );
}

// json.loads: JSON with the NaN, Infinity and -Infinity tokens.
export function pythonJsonLoads(text: string): unknown {
  const marker = `${crypto.randomUUID()}:`;
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    const token = ['-Infinity', 'Infinity', 'NaN'].find((candidate) =>
      text.startsWith(candidate, index),
    );
    if (token !== undefined) {
      out += JSON.stringify(marker + token);
      index += token.length;
      continue;
    }
    out += char;
    index++;
  }
  const tokens: Record<string, number> = {
    [`${marker}NaN`]: NaN,
    [`${marker}Infinity`]: Infinity,
    [`${marker}-Infinity`]: -Infinity,
  };
  return JSON.parse(out, (_key, value: unknown) =>
    typeof value === 'string' && value.startsWith(marker)
      ? (tokens[value] ?? value)
      : value,
  );
}

// The index after the closing quote of the string that starts at start.
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') index += 2;
    else if (text[index] === '"') return index + 1;
    else index++;
  }
  return text.length;
}
