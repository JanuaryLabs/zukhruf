import { type Schema, Validator } from '@cfworker/json-schema';
import traverse from 'json-schema-traverse';

import { type JsonData, toJsonParseValue } from '@zukhruf/python';

import { draft07 } from './draft-07-schema.ts';

// The JSON Schema of an expected record, read as jsonschema's Draft7Validator
// reads it.
export class Draft7Schema {
  static readonly #metaSchema = new Validator(draft07, '7', true);

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

  readonly value: JsonData;
  // is_valid_schema: a dict that Draft 7's meta-schema accepts.
  readonly valid: boolean;
  readonly #validator: Validator | undefined;

  constructor(value: JsonData) {
    this.value = value;
    const json = toJsonParseValue(value);
    this.valid =
      value instanceof Map && Draft7Schema.#metaSchema.validate(json).valid;
    const schema = Draft7Schema.#asDraft7(value);
    this.#validator =
      this.valid && Draft7Schema.#isSchema(schema)
        ? new Validator(schema, '7', true)
        : undefined;
  }

  // validates of evaluate.py, which it calls only for a valid schema. The
  // validator reads the JSON.parse value, and it compares 1 and 1.0 as
  // jsonschema does: an integral float is an integer.
  validates(candidate: JsonData): boolean {
    if (this.#validator === undefined)
      throw new Error(
        'evaluate.py validates a record only against a valid schema',
      );
    return this.#validator.validate(toJsonParseValue(candidate)).valid;
  }

  static #isSchema(value: unknown): value is Schema {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // The schema as Draft7Validator(schema) of evaluate.py reads it. It asserts
  // no format (evaluate.py gives it no format checker), while cfworker asserts
  // every format it knows; and it ignores the keywords of later drafts. So the
  // copy that cfworker reads has neither in any schema: json-schema-traverse
  // visits each schema of a Draft 7 schema, and its pre callback runs before it
  // steps into a keyword, so a deleted keyword is not visited.
  static #asDraft7(schema: JsonData): unknown {
    // toJsonParseValue builds new objects, so the walk deletes from a copy.
    const copy = toJsonParseValue(schema);
    if (Draft7Schema.#isSchema(copy))
      traverse(copy, {
        cb: {
          pre: (node) => {
            for (const keyword of ['format', ...Draft7Schema.#laterKeywords])
              Reflect.deleteProperty(node, keyword);
          },
        },
      });
    return copy;
  }
}
