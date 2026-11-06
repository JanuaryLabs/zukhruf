import type { JsonData } from './json-data.ts';

// A value as JSON.parse gives it.
export type JsonParseValue =
  | null
  | boolean
  | number
  | string
  | JsonParseValue[]
  | { [key: string]: JsonParseValue };

// The value that JSON.parse gives for the JSON text of a value, for code that
// reads only plain JavaScript, such as a JSON Schema validator. It loses what
// JsonData keeps: a dict becomes an object, so its integer-like keys move
// first, and an int becomes the nearest number, so an int beyond 2^53 loses
// digits. The int -0 gives 0, where JSON.parse gives -0: an int of Python has
// no negative zero. Keep the JsonData, and convert it only where such code
// reads it (ADR 0002).
export function toJsonParseValue(value: JsonData): JsonParseValue {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(toJsonParseValue);
  if (value instanceof Map)
    return Object.fromEntries(
      [...value].map(([key, item]) => [key, toJsonParseValue(item)]),
    );
  return value;
}
