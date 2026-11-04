import { loadsJson } from './cpython/python-json.ts';

// A value as Python's json.loads gives it. An int is a bigint and a float is
// a number, so `1` and `1.0` stay apart; a dict is a Map in the order of its
// keys, as JSON.parse would move integer-like keys first.
export type JsonData =
  | null
  | boolean
  | bigint
  | number
  | string
  | readonly JsonData[]
  | ReadonlyMap<string, JsonData>;

export type JsonObject = ReadonlyMap<string, JsonData>;

export const isDict = (value: JsonData | undefined): value is JsonObject =>
  value instanceof Map;

export const isList = (
  value: JsonData | undefined,
): value is readonly JsonData[] => Array.isArray(value);

// A value read without loss: JsonValue.parse reads JSON text as json.loads
// does. A scorer reads any other stated value as a JavaScript value.
export class JsonValue {
  readonly value: JsonData;

  constructor(value: JsonData) {
    this.value = value;
  }

  // Throws a SyntaxError for text that is not JSON.
  static parse(text: string): JsonValue {
    return new JsonValue(loadsJson(text));
  }
}

// The stated value of a harness as the metrics read it: its text read as
// json.loads reads it, and text that is not JSON kept as text, as the runner
// of a benchmark keeps it. Any other value stays a JavaScript value. Only a
// SyntaxError says that the text is not JSON.
export function statedValue(stated: unknown): unknown {
  if (typeof stated !== 'string') return stated;
  try {
    return JsonValue.parse(stated);
  } catch (error) {
    if (error instanceof SyntaxError) return stated;
    throw error;
  }
}

// The plain JSON value of a Python value, for a JSON Schema validator: a dict
// becomes an object and an int a number. The validator compares 1 and 1.0 as
// jsonschema does (an integral float is an integer).
export function toJson(value: JsonData): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (isList(value)) return value.map(toJson);
  if (isDict(value))
    return Object.fromEntries(
      [...value].map(([key, item]) => [key, toJson(item)]),
    );
  return value;
}
