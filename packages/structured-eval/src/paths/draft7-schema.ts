import { type Schema, Validator } from '@cfworker/json-schema';
import traverse from 'json-schema-traverse';

import { draft07 } from './draft-07-schema.ts';
import { type JsonData, isDict, toJson } from './json-value.ts';

const metaSchema = new Validator(draft07, '7', true);

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The keywords that cfworker applies under draft 7 but that Draft 7 does not
// define, so jsonschema's Draft7Validator ignores them (backlog #3775).
const laterKeywords = [
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

// The schema as Draft7Validator(schema) of evaluate.py reads it. It asserts
// no format (evaluate.py gives it no format checker), while cfworker asserts
// every format it knows; and it ignores the keywords of later drafts. So the
// copy that cfworker reads has neither in any schema: json-schema-traverse
// visits each schema of a Draft 7 schema, and its pre callback runs before it
// steps into a keyword, so a deleted keyword is not visited.
function asDraft7(schema: JsonData): unknown {
  // toJson builds new objects, so the walk deletes from a copy.
  const copy = toJson(schema);
  if (isSchema(copy))
    traverse(copy, {
      cb: {
        pre: (node) => {
          for (const keyword of ['format', ...laterKeywords])
            Reflect.deleteProperty(node, keyword);
        },
      },
    });
  return copy;
}

// The JSON Schema of an expected record, read as jsonschema's Draft7Validator
// reads it.
export class Draft7Schema {
  readonly value: JsonData;
  // is_valid_schema: a dict that Draft 7's meta-schema accepts.
  readonly valid: boolean;
  readonly #validator: Validator | undefined;

  constructor(value: JsonData) {
    this.value = value;
    const json = toJson(value);
    this.valid = isDict(value) && metaSchema.validate(json).valid;
    const schema = asDraft7(value);
    this.#validator =
      this.valid && isSchema(schema)
        ? new Validator(schema, '7', true)
        : undefined;
  }

  // validates of evaluate.py, which it calls only for a valid schema.
  validates(candidate: JsonData): boolean {
    if (this.#validator === undefined)
      throw new Error(
        'evaluate.py validates a record only against a valid schema',
      );
    return this.#validator.validate(toJson(candidate)).valid;
  }
}
