import type { JsonData } from '@zukhruf/python';

import type { JsonPair } from '../json-pair.ts';
import { dictGet } from '../json-value.ts';
import { LeafMean } from './leaf-mean.ts';

// The stated leaves whose type is the type of their path in the schema,
// through properties and items only (compute_type_precision); 0 without a
// valid schema. An unparsed value has no leaves, so it gives 0 too.
export class LeafTypePrecision extends LeafMean {
  static readonly #schemaTypes = new Set([
    'string',
    'integer',
    'number',
    'boolean',
    'object',
    'array',
    'null',
  ]);

  protected readonly whenNone = 0;

  // A schema that is not valid leaves no leaf to check, so the value is 0.
  protected leaves({
    statedLeaves,
    testCase: { schema },
  }: JsonPair): ReadonlyMap<string, JsonData> {
    return schema.valid ? statedLeaves : new Map();
  }

  protected leafValue(
    path: string,
    value: JsonData,
    { testCase: { schema } }: JsonPair,
  ): number {
    const expected = LeafTypePrecision.#schemaTypeForPath(schema.value, path);
    return expected !== undefined &&
      LeafTypePrecision.#isTypeMatch(
        LeafTypePrecision.#jsonTypeName(value),
        expected,
      )
      ? 1
      : 0;
  }

  static #isTypeMatch(actual: string, expected: string): boolean {
    return (
      actual === expected || (expected === 'number' && actual === 'integer')
    );
  }

  // schema_type_for_path of evaluate.py: through `properties` and `items` only.
  static #schemaTypeForPath(
    schema: JsonData,
    path: string,
  ): string | undefined {
    if (!(schema instanceof Map)) return undefined;
    let current: JsonData | undefined = schema;
    for (const part of LeafTypePrecision.#splitPath(path)) {
      if (!(current instanceof Map))
        throw new TypeError(
          `'${typeof current}' object has no attribute 'get'`,
        );
      if (typeof part === 'string') {
        if (current.get('type') !== 'object') return undefined;
        const properties = dictGet(current, 'properties', new Map());
        if (!(properties instanceof Map))
          throw new TypeError(
            `'${typeof properties}' object has no attribute 'get'`,
          );
        current = properties.get(part);
      } else {
        if (current.get('type') !== 'array') return undefined;
        current = current.get('items');
      }
      if (current === undefined || current === null) return undefined;
    }
    return current instanceof Map
      ? LeafTypePrecision.#normalizeSchemaType(current.get('type'))
      : undefined;
  }

  // split_path of evaluate.py: keys and integer positions. A `[` without its
  // `]` raises in Python, so it throws here.
  static #splitPath(path: string): (string | number)[] {
    const parts: (string | number)[] = [];
    let token = '';
    let index = 0;
    while (index < path.length) {
      const char = path[index];
      if (char === '.') {
        if (token) parts.push(token);
        token = '';
        index++;
      } else if (char === '[') {
        if (token) parts.push(token);
        token = '';
        const end = path.indexOf(']', index);
        if (end === -1) throw new Error('ValueError: substring not found');
        parts.push(Number.parseInt(path.slice(index + 1, end), 10));
        index = end + 1;
      } else {
        token += char;
        index++;
      }
    }
    if (token) parts.push(token);
    return parts;
  }

  // normalize_schema_type of evaluate.py. A list of more than one non-null
  // type stays a list, which Python cannot look up in a set: it raises.
  static #normalizeSchemaType(type: JsonData | undefined): string | undefined {
    let normalized = type;
    if (Array.isArray(normalized)) {
      const nonNull = normalized.filter((item) => item !== 'null');
      if (nonNull.length === 1) normalized = nonNull[0];
    }
    if (Array.isArray(normalized) || normalized instanceof Map)
      throw new TypeError(
        `unhashable type: '${Array.isArray(normalized) ? 'list' : 'dict'}'`,
      );
    return typeof normalized === 'string' &&
      LeafTypePrecision.#schemaTypes.has(normalized)
      ? normalized
      : undefined;
  }

  // json_type_name of evaluate.py: an int is `integer`, a float `number`.
  static #jsonTypeName(value: JsonData): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'bigint') return 'integer';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    return 'object';
  }
}
