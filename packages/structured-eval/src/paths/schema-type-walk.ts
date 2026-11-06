import type { JsonData } from '@zukhruf/python';

import { isRecord } from '../shared/is-record.ts';

// The type names of JSON Schema (draft 7, validation section 6.1.1).
type JsonType =
  'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

type Step = string | number;

type SchemaObject = Readonly<Record<string, unknown>>;

// The types that a JSON Schema (draft 7) allows for the value at a path of a
// stated value, such as offers[0].value.amount. The walk reads the schema as
// JSON.parse gives it: properties, patternProperties and additionalProperties
// for a name, items and additionalItems for an index, the union of anyOf and
// oneOf branches, the intersection of allOf, $refs, and type, const and enum.
// It does not read if, then, else, not or dependencies, so they restrict
// nothing here. An empty set means that the schema allows no value at the path
// (ADR 0008).
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

  readonly #root: unknown;
  // The schema that the $ref of a schema names, or undefined. Its caller
  // resolves a $ref as its validator does, so that the walk and the validator
  // read the same schema.
  readonly #referenced: (schema: SchemaObject) => unknown;

  constructor(root: unknown, referenced: (schema: SchemaObject) => unknown) {
    this.#root = root;
    this.#referenced = referenced;
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

  // followed holds the schemas whose $ref the walk followed since the last
  // step, so that a $ref loop ends.
  #allowed(
    schema: unknown,
    steps: readonly Step[],
    followed: ReadonlySet<SchemaObject>,
  ): ReadonlySet<JsonType> {
    if (schema === true) return SchemaTypeWalk.#anyType;
    if (!isRecord(schema)) return SchemaTypeWalk.#noType;
    // Draft 7 ignores the other keywords of a schema that has a $ref
    // (draft-handrews-json-schema-01, section 8.3). A $ref that names no
    // schema allows no type.
    if (typeof schema['$ref'] === 'string') {
      if (followed.has(schema)) return SchemaTypeWalk.#noType;
      return this.#allowed(
        this.#referenced(schema),
        steps,
        new Set([...followed, schema]),
      );
    }
    const [step, ...rest] = steps;
    let types =
      step === undefined
        ? SchemaTypeWalk.#ownTypes(schema)
        : this.#childTypes(schema, step, rest);
    for (const keyword of ['anyOf', 'oneOf']) {
      const branches = schema[keyword];
      if (Array.isArray(branches))
        types = types.intersection(
          SchemaTypeWalk.#union(
            branches.map((branch: unknown) =>
              this.#allowed(branch, steps, followed),
            ),
          ),
        );
    }
    const members = schema['allOf'];
    if (!Array.isArray(members)) return types;
    return members.reduce<ReadonlySet<JsonType>>(
      (all, member: unknown) =>
        all.intersection(this.#allowed(member, steps, followed)),
      types,
    );
  }

  // The types that the value under the next step can have. A step starts a
  // new list of followed $refs.
  #childTypes(
    schema: SchemaObject,
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

  // The types that a schema allows for its own value: those of type, and of
  // the values of const and enum. A schema without them allows any type.
  static #ownTypes(schema: SchemaObject): ReadonlySet<JsonType> {
    let types =
      SchemaTypeWalk.#declaredTypes(schema) ?? SchemaTypeWalk.#anyType;
    const constant = schema['const'];
    if (constant !== undefined)
      types = types.intersection(SchemaTypeWalk.#typesOfValue(constant));
    const values = schema['enum'];
    if (Array.isArray(values))
      types = types.intersection(
        SchemaTypeWalk.#union(
          values.map((value: unknown) => SchemaTypeWalk.#typesOfValue(value)),
        ),
      );
    return types;
  }

  // The types of a const or enum value: an integer is also a number.
  static #typesOfValue(value: unknown): ReadonlySet<JsonType> {
    const type = SchemaTypeWalk.#typeOf(value);
    return new Set<JsonType>(
      type === 'integer' ? ['integer', 'number'] : [type],
    );
  }

  // The schema of the item at an index: items, or the schema at its position
  // when items is a list, then additionalItems. Absent means any item.
  static #itemSchema(schema: SchemaObject, index: number): unknown {
    const items = schema['items'];
    if (!Array.isArray(items)) return items === undefined ? true : items;
    const item: unknown = items[index];
    if (item !== undefined) return item;
    const additional = schema['additionalItems'];
    return additional === undefined ? true : additional;
  }

  // The schemas that apply to a property: its own and those of each matching
  // pattern, or else additionalProperties. Absent means any value. A name
  // such as "constructor" is read only as an own property.
  static #propertySchemas(schema: SchemaObject, name: string): unknown[] {
    const schemas: unknown[] = [];
    const properties = schema['properties'];
    if (isRecord(properties) && Object.hasOwn(properties, name))
      schemas.push(properties[name]);
    const patterns = schema['patternProperties'];
    if (isRecord(patterns))
      for (const [pattern, child] of Object.entries(patterns))
        if (SchemaTypeWalk.#matches(pattern, name)) schemas.push(child);
    if (schemas.length > 0) return schemas;
    const additional = schema['additionalProperties'];
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
    schema: SchemaObject,
  ): ReadonlySet<JsonType> | undefined {
    const type = schema['type'];
    if (type === undefined) return undefined;
    const names: readonly unknown[] = Array.isArray(type) ? type : [type];
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

  // The draft 7 type of a stated value or of a value in the schema: an int,
  // or a float with a zero fraction such as 1.0, is an integer (validation
  // section 6.1.1), though Python reads 1.0 as a float (ADR 0008). An object
  // is a Map of a stated value, or an object of the schema.
  static #typeOf(value: unknown): JsonType {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    switch (typeof value) {
      case 'object':
        return 'object';
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
