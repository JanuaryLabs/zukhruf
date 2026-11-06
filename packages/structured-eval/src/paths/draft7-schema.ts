import {
  type Schema,
  Validator,
  dereference,
  validate,
} from '@cfworker/json-schema';
import traverse from 'json-schema-traverse';

import {
  type JsonData,
  type JsonParseValue,
  toJsonParseValue,
} from '@zukhruf/python';

import { isRecord } from '../shared/is-record.ts';
import { draft07 } from './draft-07-schema.ts';
import { SchemaTypeWalk } from './schema-type-walk.ts';

// The JSON Schema of an expected record, read as jsonschema's Draft7Validator
// reads it.
export class Draft7Schema {
  // The keywords that cfworker applies under draft 7 but that Draft 7 does not
  // define, so jsonschema's Draft7Validator ignores them (backlog #3775).
  static readonly #laterKeywords = [
    'prefixItems',
    'dependentRequired',
    'dependentSchemas',
    'unevaluatedProperties',
    'unevaluatedItems',
    'minContains',
    'maxContains',
    '$recursiveRef',
    '$recursiveAnchor',
    '$dynamicRef',
    '$dynamicAnchor',
  ];

  // check_schema asserts the regex format of the meta-schema only: jsonschema
  // checks uri and uri-reference only with its format extras, which evaluate.py
  // does not install.
  static readonly #metaSchema = new Validator(
    Draft7Schema.#asDraft7(structuredClone(draft07), ['regex']),
    '7',
    true,
  );

  // The meta-schema that a $ref reaches through the registry of jsonschema, as
  // Draft7Validator(schema) reads it, and its URI as cfworker writes it: with
  // no empty fragment.
  static readonly #referencedMetaSchema = Draft7Schema.#asDraft7(
    structuredClone(draft07),
    [],
  );
  static readonly #metaSchemaUri = 'http://json-schema.org/draft-07/schema';

  readonly value: JsonData;
  // The types that the schema allows at a path (ADR 0008).
  readonly types: SchemaTypeWalk;
  // The schema when it is valid, as Draft7Validator(schema) of evaluate.py
  // reads it: that validator has no format checker.
  readonly #validSchema: Readonly<Record<string, unknown>> | undefined;
  readonly #lookup: Readonly<Record<string, Schema | boolean>>;

  constructor(value: JsonData) {
    this.value = value;
    const schema = Draft7Schema.#asDraft7(toJsonParseValue(value), []);
    this.#lookup = Draft7Schema.#lookupOf(schema);
    this.types = new SchemaTypeWalk(schema, (node) => this.#referenced(node));
    this.#validSchema =
      value instanceof Map &&
      isRecord(schema) &&
      Draft7Schema.#metaSchema.validate(toJsonParseValue(value)).valid
        ? schema
        : undefined;
  }

  // is_valid_schema: a dict that Draft 7's meta-schema accepts.
  get valid(): boolean {
    return this.#validSchema !== undefined;
  }

  // validates of evaluate.py, which it calls only for a valid schema. The
  // validator reads the JSON.parse value, and it compares 1 and 1.0 as
  // jsonschema does: an integral float is an integer.
  validates(candidate: JsonData): boolean {
    if (this.#validSchema === undefined)
      throw new Error(
        'evaluate.py validates a record only against a valid schema',
      );
    return validate(
      toJsonParseValue(candidate),
      this.#validSchema,
      '7',
      this.#lookup,
      true,
    ).valid;
  }

  // The schema that the $ref of a schema names, as Draft7Validator(schema)
  // resolves it, or undefined: dereference writes the absolute URI of each
  // $ref, and the lookup holds each schema by its URI.
  #referenced({ __absolute_ref__: uri }: Schema): unknown {
    return uri === undefined ? undefined : this.#lookup[uri];
  }

  // The schemas that a $ref of the schema can name, by URI: those of the
  // schema, and the meta-schema, which the registry of jsonschema holds at its
  // URI. A schema whose own $id is that URI takes its place, as in jsonschema.
  // cfworker has no registry, and Validator.addSchema throws for such a
  // schema, so the lookup is built with dereference, which Validator calls.
  static #lookupOf(
    schema: JsonParseValue,
  ): Readonly<Record<string, Schema | boolean>> {
    const lookup: Record<string, Schema | boolean> = isRecord(schema)
      ? dereference(schema)
      : {};
    if (lookup[Draft7Schema.#metaSchemaUri] === undefined)
      dereference(Draft7Schema.#referencedMetaSchema, lookup);
    return lookup;
  }

  // A schema as one call of jsonschema reads it. jsonschema asserts only the
  // formats that the call asserts, while cfworker asserts every format it
  // knows; and Draft 7 ignores the keywords of later drafts. So the walk
  // deletes the other formats and the later keywords from the copy that it is
  // given: json-schema-traverse visits each schema of a Draft 7 schema, and its
  // pre callback runs before it steps into a keyword, so a deleted keyword is
  // not visited.
  static #asDraft7<T>(copy: T, assertedFormats: readonly string[]): T {
    if (isRecord(copy))
      traverse(copy, {
        cb: {
          pre: (node) => {
            if (!assertedFormats.some((format) => node['format'] === format))
              Reflect.deleteProperty(node, 'format');
            for (const keyword of Draft7Schema.#laterKeywords)
              Reflect.deleteProperty(node, keyword);
          },
        },
      });
    return copy;
  }
}
