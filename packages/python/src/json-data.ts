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
