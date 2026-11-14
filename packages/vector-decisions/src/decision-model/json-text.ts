import type { JSONValue } from 'ai';

// The smallest size of a float that Python's repr writes without an
// exponent.
const FIXED_FROM = 1e-4;

// The text that the reader embeds for a JSON value, as Venn's
// decisions.text writes it (venn/decisions.py:33): a string is itself, and
// other JSON is Python's json.dumps with sort_keys and ensure_ascii=False.
export function jsonText(value: JSONValue): string {
  return typeof value === 'string' ? value : pythonJson(value);
}

// Python's json.dumps of the value that JSON.stringify sends to Python:
// ", " between items, ": " after each key, the keys of each object in the
// order of their code points, and each number as Python writes the int or
// the float that it reads. As JSON.stringify does, an object leaves out a
// property that is undefined.
function pythonJson(value: JSONValue): string {
  if (Array.isArray(value))
    return `[${value.map((item: JSONValue) => pythonJson(item)).join(', ')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter((entry): entry is [string, JSONValue] => entry[1] !== undefined)
      .sort(([one], [other]) =>
        Buffer.compare(Buffer.from(one), Buffer.from(other)),
      )
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
      .join(', ')}}`;
  if (typeof value === 'number') return pythonNumber(value);
  return JSON.stringify(value);
}

// JSON.stringify writes a whole number without a point, which Python reads
// as an int and writes the same. Python reads a number with a point or an
// exponent as a float, whose repr under 1e-4 has an exponent of two digits
// or more, where JavaScript writes 0.00001 or 1e-7.
function pythonNumber(value: number): string {
  const json = JSON.stringify(value);
  if (!/[.e]/.test(json) || Math.abs(value) >= FIXED_FROM) return json;
  return value.toExponential().replace(/(?<=e[+-])\d$/, (digit) => `0${digit}`);
}
