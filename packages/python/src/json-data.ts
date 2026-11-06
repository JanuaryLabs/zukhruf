// A value as Python's json.loads gives it. An int is a bigint and a float is
// a number, so `1` and `1.0` stay apart; a dict is a Map in the order of its
// keys, as JSON.parse would move integer-like keys first. A list and a dict
// are mutable, as in Python, so Array.isArray and instanceof Map narrow a
// value: TypeScript cannot narrow a readonly array or a ReadonlyMap away.
export type JsonData =
  | null
  | boolean
  | bigint
  | number
  | string
  | JsonData[]
  | Map<string, JsonData>;
