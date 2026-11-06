import type { JsonData } from '@zukhruf/python';

// The type names of JSON Schema (draft 7, validation section 6.1.1).
type JsonType =
  'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

type Step = string | number;

// The types that a JSON Schema (draft 7) allows for the value at a path of a
// stated value, such as offers[0].value.amount. The walk reads properties,
// patternProperties and additionalProperties for a name, items and
// additionalItems for an index, the union of anyOf and oneOf branches, the
// intersection of allOf, local $refs, and type, const and enum. It does not
// read if, then, else, not or dependencies, so they restrict nothing here.
// An empty set means that the schema allows no value at the path (ADR 0008).
export class SchemaTypeWalk {
  static readonly #anyType: ReadonlySet<JsonType> = new Set<JsonType>([
    'string',
    'integer',
    'number',
    'boolean',
    'object',
    'array',
    'null',
  ]);

  static readonly #noType: ReadonlySet<JsonType> = new Set<JsonType>();

  // The type names, for reading the type keyword of a schema.
  static readonly #names: ReadonlySet<string> = SchemaTypeWalk.#anyType;

  // The schema that the walk starts from, for local $refs.
  readonly #root: JsonData;

  constructor(schema: JsonData) {
    this.#root = schema;
  }

  // Whether the schema allows the type of the value at the path. An integer
  // is also a number (draft 7, validation section 6.1.1).
  allows(path: string, value: JsonData): boolean {
    const allowed = this.#typesAt(path);
    const type = SchemaTypeWalk.#typeOf(value);
    return allowed.has(type) || (type === 'integer' && allowed.has('number'));
  }

  #typesAt(path: string): ReadonlySet<JsonType> {
    const steps = SchemaTypeWalk.#stepsOf(path);
    if (steps === undefined) return SchemaTypeWalk.#noType;
    return this.#allowed(this.#root, steps, new Set());
  }

  // refs are the $refs followed since the last step, so that a $ref loop
  // ends.
  #allowed(
    schema: JsonData,
    steps: readonly Step[],
    refs: ReadonlySet<string>,
  ): ReadonlySet<JsonType> {
    if (schema === true) return SchemaTypeWalk.#anyType;
    if (!(schema instanceof Map)) return SchemaTypeWalk.#noType;
    // Draft 7 ignores the other keywords of a schema that has a $ref
    // (draft-handrews-json-schema-01, section 8.3).
    const ref = schema.get('$ref');
    if (typeof ref === 'string') {
      if (refs.has(ref)) return SchemaTypeWalk.#noType;
      const target = this.#resolve(ref);
      if (target === undefined) return SchemaTypeWalk.#noType;
      return this.#allowed(target, steps, new Set([...refs, ref]));
    }
    const [step, ...rest] = steps;
    let types =
      step === undefined
        ? SchemaTypeWalk.#ownTypes(schema)
        : this.#childTypes(schema, step, rest);
    for (const keyword of ['anyOf', 'oneOf']) {
      const branches = schema.get(keyword);
      if (Array.isArray(branches))
        types = types.intersection(
          SchemaTypeWalk.#union(
            branches.map((branch) => this.#allowed(branch, steps, refs)),
          ),
        );
    }
    const members = schema.get('allOf');
    if (Array.isArray(members))
      for (const member of members)
        types = types.intersection(this.#allowed(member, steps, refs));
    return types;
  }

  // The types that the value under the next step can have. A step starts a
  // new list of followed $refs.
  #childTypes(
    schema: Map<string, JsonData>,
    step: Step,
    rest: readonly Step[],
  ): ReadonlySet<JsonType> {
    const declared = SchemaTypeWalk.#declaredTypes(schema);
    if (typeof step === 'number') {
      if (declared !== undefined && !declared.has('array'))
        return SchemaTypeWalk.#noType;
      return this.#allowed(
        SchemaTypeWalk.#itemSchema(schema, step),
        rest,
        new Set(),
      );
    }
    if (declared !== undefined && !declared.has('object'))
      return SchemaTypeWalk.#noType;
    return SchemaTypeWalk.#propertySchemas(schema, step).reduce<
      ReadonlySet<JsonType>
    >(
      (types, child) =>
        types.intersection(this.#allowed(child, rest, new Set())),
      SchemaTypeWalk.#anyType,
    );
  }

  // The schema that a local $ref names: "#" or a JSON Pointer after "#"
  // (RFC 6901). Any other $ref, such as a URL, names no schema here.
  #resolve(ref: string): JsonData | undefined {
    if (!ref.startsWith('#')) return undefined;
    let pointer: string;
    try {
      pointer = decodeURIComponent(ref.slice(1));
    } catch (error) {
      if (error instanceof URIError) return undefined;
      throw error;
    }
    if (pointer === '') return this.#root;
    if (!pointer.startsWith('/')) return undefined;
    let current: JsonData | undefined = this.#root;
    for (const token of pointer.slice(1).split('/')) {
      const name = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if (Array.isArray(current)) current = current[Number(name)];
      else if (current instanceof Map) current = current.get(name);
      else return undefined;
      if (current === undefined) return undefined;
    }
    return current;
  }

  // The types that a schema allows for its own value: those of type, and of
  // the values of const and enum. A schema without them allows any type.
  static #ownTypes(schema: Map<string, JsonData>): ReadonlySet<JsonType> {
    let types =
      SchemaTypeWalk.#declaredTypes(schema) ?? SchemaTypeWalk.#anyType;
    const constant = schema.get('const');
    if (constant !== undefined)
      types = types.intersection(SchemaTypeWalk.#typesOfValue(constant));
    const values = schema.get('enum');
    if (Array.isArray(values))
      types = types.intersection(
        SchemaTypeWalk.#union(
          values.map((value) => SchemaTypeWalk.#typesOfValue(value)),
        ),
      );
    return types;
  }

  // The types of a const or enum value: an integer is also a number.
  static #typesOfValue(value: JsonData): ReadonlySet<JsonType> {
    const type = SchemaTypeWalk.#typeOf(value);
    return new Set<JsonType>(
      type === 'integer' ? ['integer', 'number'] : [type],
    );
  }

  // The schema of the item at an index: items, or the schema at its position
  // when items is a list, then additionalItems. Absent means any item.
  static #itemSchema(schema: Map<string, JsonData>, index: number): JsonData {
    const items = schema.get('items');
    if (!Array.isArray(items)) return items === undefined ? true : items;
    const item = items[index];
    if (item !== undefined) return item;
    const additional = schema.get('additionalItems');
    return additional === undefined ? true : additional;
  }

  // The schemas that apply to a property: its own and those of each matching
  // pattern, or else additionalProperties. Absent means any value.
  static #propertySchemas(
    schema: Map<string, JsonData>,
    name: string,
  ): JsonData[] {
    const schemas: JsonData[] = [];
    const properties = schema.get('properties');
    const own = properties instanceof Map ? properties.get(name) : undefined;
    if (own !== undefined) schemas.push(own);
    const patterns = schema.get('patternProperties');
    if (patterns instanceof Map)
      for (const [pattern, child] of patterns)
        if (SchemaTypeWalk.#matches(pattern, name)) schemas.push(child);
    if (schemas.length > 0) return schemas;
    const additional = schema.get('additionalProperties');
    return [additional === undefined ? true : additional];
  }

  // Whether a patternProperties pattern matches a name. A pattern that is not
  // a regular expression matches no name: a schema with one is not valid.
  static #matches(pattern: string, name: string): boolean {
    try {
      return new RegExp(pattern, 'u').test(name);
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }

  // The types of a schema's type keyword: a name or a list of names.
  static #declaredTypes(
    schema: Map<string, JsonData>,
  ): ReadonlySet<JsonType> | undefined {
    const type = schema.get('type');
    if (type === undefined) return undefined;
    const names = Array.isArray(type) ? type : [type];
    return new Set(
      names.filter(
        (name): name is JsonType =>
          typeof name === 'string' && SchemaTypeWalk.#names.has(name),
      ),
    );
  }

  // The steps of a path: a property name for each name, and the index for
  // each [index]. Empty names between dots are skipped. A path that JsonPair
  // cannot make, such as a "[" with no "]", has no steps. A name that holds
  // "." or "[" reads as several steps: JsonPair writes it the same way.
  static #stepsOf(path: string): Step[] | undefined {
    const steps: Step[] = [];
    const parts = /([^.[]+)|\[(\d+)\]|\./y;
    while (parts.lastIndex < path.length) {
      const match = parts.exec(path);
      if (match === null) return undefined;
      const [, name, index] = match;
      if (name !== undefined) steps.push(name);
      else if (index !== undefined) steps.push(Number(index));
    }
    return steps;
  }

  static #union(sets: readonly ReadonlySet<JsonType>[]): ReadonlySet<JsonType> {
    return sets.reduce<ReadonlySet<JsonType>>(
      (all, set) => all.union(set),
      SchemaTypeWalk.#noType,
    );
  }

  // The draft 7 type of a JSON value: an int, or a float with a zero
  // fraction such as 1.0, is an integer (validation section 6.1.1), though
  // Python reads 1.0 as a float (ADR 0008).
  static #typeOf(value: JsonData): JsonType {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Map) return 'object';
    switch (typeof value) {
      case 'boolean':
        return 'boolean';
      case 'bigint':
        return 'integer';
      case 'number':
        return Number.isInteger(value) ? 'integer' : 'number';
      default:
        return 'string';
    }
  }
}
