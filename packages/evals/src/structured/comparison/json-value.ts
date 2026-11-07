import { type JsonData, loadsJson } from '@zukhruf/python';

// A value read without loss: JsonValue.parse reads JSON text as json.loads
// does, and JsonValue.from reads a JavaScript value as json.loads reads its
// JSON text. A JavaScript value enters the package only through them.
export class JsonValue {
  readonly value: JsonData;

  constructor(value: JsonData) {
    this.value = value;
  }

  // Throws a SyntaxError for text that is not JSON.
  static parse(text: string): JsonValue {
    return new JsonValue(loadsJson(text));
  }

  // An integral number becomes an int, so an integral float such as 7.0 is
  // already 7. JSON.stringify gives no text for undefined, which stands for no
  // value (None). JSON.stringify gives {} for a Map and a Set, at any depth, so
  // a dict of JsonData would become an empty object: that value is refused,
  // and not read.
  static from(value: unknown): JsonValue {
    return new JsonValue(
      value === undefined
        ? null
        : loadsJson(JSON.stringify(value, JsonValue.#refuseCollections)),
    );
  }

  static #refuseCollections(this: void, _key: string, item: unknown): unknown {
    if (item instanceof Map || item instanceof Set)
      throw new TypeError(
        `JsonValue.from cannot read a ${item instanceof Map ? 'Map' : 'Set'}, because JSON.stringify loses its entries. Give JSON text, a JsonValue or a plain JavaScript value.`,
      );
    return item;
  }
}

// What a stated value is to the walk: a value that JsonValue.parse or
// JsonValue.from read, as it is; a text read as json.loads reads it, and a text
// that is not JSON kept as that text, as the runner of a benchmark keeps it;
// any other value read as json.loads reads its JSON text. So a stated string
// that a caller already parsed enters as a JsonValue. Only a SyntaxError says
// that the text is not JSON.
export function statedData(stated: unknown): JsonData {
  if (stated instanceof JsonValue) return stated.value;
  if (typeof stated !== 'string') return JsonValue.from(stated).value;
  try {
    return JsonValue.parse(stated).value;
  } catch (error) {
    if (error instanceof SyntaxError) return stated;
    throw error;
  }
}

// dict.get(key, default) of Python: a key whose value is None gives None, and
// only a missing key gives the default.
export function dictGet(
  dict: ReadonlyMap<string, JsonData>,
  key: string,
  fallback: JsonData,
): JsonData {
  const value = dict.get(key);
  return value === undefined ? fallback : value;
}
