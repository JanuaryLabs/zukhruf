import {
  type JsonData,
  type JsonObject,
  isDict,
  isList,
} from './json-value.ts';

// The leaf paths of evaluate.py: `a.b[0].c`. A dict and a list give their
// children; any other value is a leaf (null too); a value at an empty path,
// such as a scalar root, is no leaf; a later equal path takes the value and
// keeps the first place, as dict.update does.
export function flattenLeafPaths(
  value: JsonData | undefined,
  prefix = '',
): Map<string, JsonData> {
  const leaves = new Map<string, JsonData>();
  if (isDict(value)) {
    for (const [key, child] of value)
      for (const [path, leaf] of flattenLeafPaths(
        child,
        prefix ? `${prefix}.${key}` : key,
      ))
        leaves.set(path, leaf);
    return leaves;
  }
  if (isList(value)) {
    for (const [index, child] of value.entries())
      for (const [path, leaf] of flattenLeafPaths(child, `${prefix}[${index}]`))
        leaves.set(path, leaf);
    return leaves;
  }
  if (prefix && value !== undefined) leaves.set(prefix, value);
  return leaves;
}

// flatten_present_paths of evaluate.py: every path, of containers too.
export function flattenPresentPaths(
  value: JsonData | undefined,
  prefix = '',
): Set<string> {
  const paths = new Set<string>();
  if (prefix) paths.add(prefix);
  if (isDict(value))
    for (const [key, child] of value)
      for (const path of flattenPresentPaths(
        child,
        prefix ? `${prefix}.${key}` : key,
      ))
        paths.add(path);
  else if (isList(value))
    for (const [index, child] of value.entries())
      for (const path of flattenPresentPaths(child, `${prefix}[${index}]`))
        paths.add(path);
  return paths;
}

// INDEX_RE of evaluate.py; Python's \d is any Unicode decimal digit.
export const wildcardPath = (path: string) =>
  path.replaceAll(/\[\p{Nd}+\]/gu, '[]');

// dict.get(key, default) of Python.
const get = (dict: JsonObject, key: string, fallback: JsonData): JsonData => {
  const value = dict.get(key);
  return value === undefined ? fallback : value;
};

// required_paths of evaluate.py: the required keys of each object schema,
// through `properties` and `items` only.
export function requiredPaths(schema: JsonData, prefix = ''): string[] {
  if (!isDict(schema)) return [];
  const type = schema.get('type');
  const results: string[] = [];
  if (type === 'object') {
    const properties = get(schema, 'properties', new Map());
    for (const key of iterate(get(schema, 'required', []))) {
      const child = isDict(properties)
        ? get(properties, String(key), new Map())
        : new Map();
      const path = prefix ? `${prefix}.${String(key)}` : String(key);
      results.push(path, ...requiredPaths(child, path));
    }
  } else if (type === 'array') {
    results.push(
      ...requiredPaths(
        get(schema, 'items', new Map()),
        prefix ? `${prefix}[]` : '[]',
      ),
    );
  }
  return results;
}

// A Python for loop over a list, the keys of a dict, or the characters of a
// str.
const iterate = (value: JsonData): readonly JsonData[] => {
  if (isList(value)) return value;
  if (isDict(value)) return [...value.keys()];
  if (typeof value === 'string') return [...value];
  return [];
};

// split_path of evaluate.py: keys and integer positions. A `[` without its
// `]` raises in Python, so it throws here.
function splitPath(path: string): (string | number)[] {
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

const schemaTypes = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'object',
  'array',
  'null',
]);

// normalize_schema_type of evaluate.py. A list of more than one non-null
// type stays a list, which Python cannot look up in a set: it raises.
function normalizeSchemaType(type: JsonData | undefined): string | undefined {
  let normalized = type;
  if (isList(normalized)) {
    const nonNull = normalized.filter((item) => item !== 'null');
    if (nonNull.length === 1) normalized = nonNull[0];
  }
  if (isList(normalized) || isDict(normalized))
    throw new TypeError(
      `unhashable type: '${isList(normalized) ? 'list' : 'dict'}'`,
    );
  return typeof normalized === 'string' && schemaTypes.has(normalized)
    ? normalized
    : undefined;
}

// schema_type_for_path of evaluate.py: through `properties` and `items` only.
export function schemaTypeForPath(
  schema: JsonData,
  path: string,
): string | undefined {
  if (!isDict(schema)) return undefined;
  let current: JsonData | undefined = schema;
  for (const part of splitPath(path)) {
    if (!isDict(current))
      throw new TypeError(`'${typeof current}' object has no attribute 'get'`);
    if (typeof part === 'string') {
      if (current.get('type') !== 'object') return undefined;
      const properties = get(current, 'properties', new Map());
      if (!isDict(properties))
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
  return isDict(current) ? normalizeSchemaType(current.get('type')) : undefined;
}

// json_type_name of evaluate.py: an int is `integer`, a float `number`.
export function jsonTypeName(value: JsonData): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'bigint') return 'integer';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (isList(value)) return 'array';
  return 'object';
}
