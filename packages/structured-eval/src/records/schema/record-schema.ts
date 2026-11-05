import {
  type Schema,
  type SchemaDraft,
  Validator,
} from '@cfworker/json-schema';

import { TypeSafety } from '../measures/type-safety.ts';
import { Validity } from '../measures/validity.ts';
import type { RecordLeaves } from '../record-leaves.ts';
import type { SchemaMeasures, SchemaRule } from './schema-rule.ts';
import { SchemaTypes } from './schema-types.ts';

// The JSON Schema of a record, such as the output of z.toJSONSchema. It
// checks the whole record, formats included, as zod does.
export class RecordSchema implements SchemaRule {
  static readonly #drafts: Readonly<Record<string, SchemaDraft>> = {
    'https://json-schema.org/draft/2020-12/schema': '2020-12',
    'https://json-schema.org/draft/2019-09/schema': '2019-09',
    'http://json-schema.org/draft-07/schema': '7',
    'http://json-schema.org/draft-04/schema': '4',
  };

  readonly #validator: Validator;
  readonly #types: SchemaTypes;

  constructor(json: object) {
    if (!RecordSchema.#isSchema(json))
      throw new TypeError('A JSON Schema is an object, not an array');
    this.#validator = new Validator(json, RecordSchema.#draftOf(json), false);
    this.#types = new SchemaTypes(json);
  }

  measure(stated: unknown, leaves: RecordLeaves): SchemaMeasures {
    const validity = new Validity(this.#validator.validate(stated));
    const typeSafety = new TypeSafety(this.#types, leaves.of(stated));
    return {
      valid: validity.valid,
      reason: validity.reason,
      *ratios() {
        yield* validity.ratios();
        yield* typeSafety.ratios();
      },
    };
  }

  // Any JSON object is a schema to the validator: it reads the keywords it
  // knows. The parameter is `object`, so a schema from any library fits.
  static #isSchema(json: object): json is Schema {
    return !Array.isArray(json);
  }

  // The `$schema` keyword names the draft; a schema without it is 2020-12.
  static #draftOf(schema: Schema): SchemaDraft {
    const uri = schema.$schema;
    if (uri === undefined) return '2020-12';
    const draft = RecordSchema.#drafts[uri.replace(/#$/, '')];
    if (draft === undefined)
      throw new Error(
        `The $schema ${uri} is not a draft that the package reads: 4, 7, 2019-09 or 2020-12`,
      );
    return draft;
  }
}
