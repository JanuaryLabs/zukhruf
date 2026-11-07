import {
  type OutputUnit,
  type Schema,
  Validator,
  dereference,
  validate,
} from '@cfworker/json-schema';

import {
  type JsonData,
  type JsonParseValue,
  toJsonParseValue,
} from '@zukhruf/python';

import type { JsonValue } from '../comparison/json-value.ts';
import { draft07 } from './draft-07-schema.ts';
import {
  draft202012,
  draft202012Vocabularies,
} from './draft-2020-12-schema.ts';
import { isRecord } from './is-record.ts';
import { SchemaTypeWalk } from './schema-type-walk.ts';

// The version of JSON Schema that reads a schema.
export type Draft = '7' | '2020-12';

// What the validator says about one value: if it agrees with the schema, and
// the errors, each as its location and its message, such as
// `/offers/0/amount Instance type "string" is invalid. Expected "number".`
export type Validation = {
  readonly valid: boolean;
  readonly errors: readonly string[];
};

type SchemaObject = Record<string, unknown>;

// A JSON Schema, read with one draft (Facade over cfworker's validator). The
// draft is the one that the schema's own $schema names, else 2020-12, unless
// the caller sets it: jsonschema's Draft7Validator reads every schema as
// draft 7, whatever its $schema says. The validator and the walk of the types
// read the schema with that one draft, and each $ref through one lookup, so
// one schema has one meaning (ADR 0011). A format is an annotation: it fails
// no value, as the 2020-12 format-annotation vocabulary says and as
// Draft7Validator, which has no format checker, does.
export class JsonSchema {
  static readonly #drafts: ReadonlyMap<string, Draft> = new Map([
    ['http://json-schema.org/draft-07/schema', '7'],
    ['https://json-schema.org/draft/2020-12/schema', '2020-12'],
  ]);

  // The keywords that cfworker applies in any draft but that the draft does
  // not define, so a validator of that draft ignores them (backlog #3775).
  static readonly #otherKeywords: Readonly<Record<Draft, readonly string[]>> = {
    '7': [
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
    ],
    '2020-12': [
      'additionalItems',
      'dependencies',
      '$recursiveRef',
      '$recursiveAnchor',
    ],
  };

  // The keywords whose value is a schema, a list of schemas, or a map of
  // schemas, in draft 7 and 2020-12. json-schema-traverse 1.0.0, its latest
  // version, has no prefixItems, dependentSchemas or unevaluated keywords, so
  // the package walks the schemas itself.
  static readonly #schemaKeywords = new Set([
    'additionalItems',
    'items',
    'contains',
    'additionalProperties',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]);
  static readonly #listKeywords = new Set([
    'items',
    'prefixItems',
    'allOf',
    'anyOf',
    'oneOf',
  ]);
  static readonly #mapKeywords = new Set([
    '$defs',
    'definitions',
    'properties',
    'patternProperties',
    'dependencies',
    'dependentSchemas',
  ]);

  // cfworker reports each failed keyword, also the keywords that only hold a
  // failed child (properties, items, $ref …). The errors name the others.
  static readonly #containers = new Set([
    'properties',
    'patternProperties',
    'additionalProperties',
    'items',
    'prefixItems',
    'additionalItems',
    'contains',
    'allOf',
    'anyOf',
    'oneOf',
    '$ref',
    'dependentSchemas',
    'unevaluatedProperties',
    'unevaluatedItems',
  ]);

  // The meta-schema of each draft, as jsonschema's check_schema reads it: it
  // asserts the regex format only, because jsonschema checks uri and
  // uri-reference only with its format extras, which evaluate.py does not
  // install.
  static readonly #metaSchemas: Readonly<Record<Draft, Validator>> = {
    '7': new Validator(
      JsonSchema.#prepared(structuredClone(draft07), '7', ['regex']),
      '7',
      true,
    ),
    '2020-12': JsonSchema.#metaSchema2020(['regex']),
  };

  // The meta-schemas that a $ref of a schema reaches through the registry of
  // jsonschema, as a validator of the draft reads them.
  static readonly #referencedMetaSchemas: Readonly<
    Record<Draft, readonly Schema[]>
  > = {
    '7': [JsonSchema.#prepared(structuredClone(draft07), '7', [])],
    '2020-12': [draft202012, ...draft202012Vocabularies].map((schema) =>
      JsonSchema.#prepared(JsonSchema.#static(schema), '2020-12', []),
    ),
  };

  readonly value: JsonData;
  readonly draft: Draft;
  // The types that the schema allows at a path (ADR 0008).
  readonly types: SchemaTypeWalk;
  // The schema when it is valid, as the validator reads it.
  readonly #validSchema: Readonly<Record<string, unknown>> | undefined;
  readonly #lookup: Readonly<Record<string, Schema | boolean>>;

  constructor(value: JsonValue, { draft }: { readonly draft?: Draft } = {}) {
    this.value = value.value;
    this.draft = draft ?? JsonSchema.#draftOf(this.value);
    const schema = JsonSchema.#prepared(
      toJsonParseValue(this.value),
      this.draft,
      [],
    );
    this.#lookup = this.#lookupOf(schema);
    this.types = new SchemaTypeWalk(
      schema,
      (node) => this.#referenced(node),
      this.draft,
    );
    this.#validSchema =
      this.value instanceof Map &&
      isRecord(schema) &&
      JsonSchema.#metaSchemas[this.draft].validate(toJsonParseValue(this.value))
        .valid
        ? schema
        : undefined;
  }

  // is_valid_schema of evaluate.py: a dict that the meta-schema of the draft
  // accepts.
  get valid(): boolean {
    return this.#validSchema !== undefined;
  }

  // Checks a value against the schema, which must be valid. The validator
  // reads the JSON.parse value, and it compares 1 and 1.0 as jsonschema does:
  // an integral float is an integer.
  validate(value: JsonData): Validation {
    if (this.#validSchema === undefined)
      throw new Error('A value is checked only against a valid schema');
    const result = validate(
      toJsonParseValue(value),
      this.#validSchema,
      this.draft,
      this.#lookup,
      false,
    );
    return {
      valid: result.valid,
      errors: [
        ...new Set(
          result.errors
            .filter((error) => !JsonSchema.#containers.has(error.keyword))
            .map((error) => JsonSchema.#line(error)),
        ),
      ],
    };
  }

  // The schema that the $ref of a schema names, as the validator resolves it,
  // or undefined: dereference writes the absolute URI of each $ref, and the
  // lookup holds each schema by its URI.
  #referenced({ __absolute_ref__: uri }: Schema): unknown {
    return uri === undefined ? undefined : this.#lookup[uri];
  }

  // The schemas that a $ref of the schema can name, by URI: those of the
  // schema, and the meta-schemas of its draft, which the registry of
  // jsonschema holds at their URIs. A schema whose own $id is such a URI
  // takes its place, as in jsonschema. cfworker has no registry, and
  // Validator.addSchema throws for such a schema, so the lookup is built with
  // dereference, which Validator calls.
  #lookupOf(
    schema: JsonParseValue,
  ): Readonly<Record<string, Schema | boolean>> {
    const lookup: Record<string, Schema | boolean> = isRecord(schema)
      ? dereference(schema)
      : {};
    for (const meta of JsonSchema.#referencedMetaSchemas[this.draft])
      if (
        meta.$id !== undefined &&
        lookup[meta.$id.replace(/#$/, '')] === undefined
      )
        dereference(meta, lookup);
    return lookup;
  }

  // The $schema keyword names the draft; a schema without it, or with a
  // $schema that is not text, is read as 2020-12.
  static #draftOf(value: JsonData): Draft {
    const uri = value instanceof Map ? value.get('$schema') : undefined;
    if (typeof uri !== 'string') return '2020-12';
    const draft = JsonSchema.#drafts.get(uri.replace(/#$/, ''));
    if (draft === undefined)
      throw new Error(
        `The $schema ${uri} is not a draft that the package reads: 7 or 2020-12`,
      );
    return draft;
  }

  // The 2020-12 meta-schema with its vocabularies.
  static #metaSchema2020(assertedFormats: readonly string[]): Validator {
    const validator = new Validator(
      JsonSchema.#prepared(
        JsonSchema.#static(draft202012),
        '2020-12',
        assertedFormats,
      ),
      '2020-12',
      true,
    );
    for (const vocabulary of draft202012Vocabularies)
      validator.addSchema(
        JsonSchema.#prepared(
          JsonSchema.#static(vocabulary),
          '2020-12',
          assertedFormats,
        ),
      );
    return validator;
  }

  // A copy of a 2020-12 meta-schema whose `$dynamicRef: "#meta"` is a $ref to
  // the meta-schema. cfworker 4.1.4 has no $dynamicRef, and with no other
  // `$dynamicAnchor: "meta"` in reach, the dynamic reference of each
  // vocabulary resolves to the 2020-12 meta-schema (core section 8.2.3.2).
  static #static(schema: Schema): Schema {
    const copy = structuredClone(schema);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      if (!isRecord(value)) return;
      if (value['$dynamicRef'] === '#meta') {
        Reflect.deleteProperty(value, '$dynamicRef');
        Reflect.set(
          value,
          '$ref',
          'https://json-schema.org/draft/2020-12/schema',
        );
      }
      Object.values(value).forEach(visit);
    };
    visit(copy);
    return copy;
  }

  // A schema as a validator of the draft reads it, without the formats that
  // it does not assert: cfworker asserts every format that it knows, and it
  // applies the keywords of every draft. So the walk deletes the other
  // formats and the keywords of other drafts from the copy that it is given,
  // in each schema before it steps into its keywords, so a deleted keyword is
  // not visited.
  static #prepared<T>(
    copy: T,
    draft: Draft,
    assertedFormats: readonly string[],
  ): T {
    const visit = (node: unknown): void => {
      if (!isRecord(node)) return;
      const schema: SchemaObject = node;
      if (!assertedFormats.some((format) => schema['format'] === format))
        Reflect.deleteProperty(schema, 'format');
      for (const keyword of JsonSchema.#otherKeywords[draft])
        Reflect.deleteProperty(schema, keyword);
      for (const [keyword, child] of Object.entries(schema)) {
        if (Array.isArray(child)) {
          if (JsonSchema.#listKeywords.has(keyword)) child.forEach(visit);
        } else if (JsonSchema.#mapKeywords.has(keyword)) {
          if (isRecord(child)) Object.values(child).forEach(visit);
        } else if (JsonSchema.#schemaKeywords.has(keyword)) visit(child);
      }
    };
    visit(copy);
    return copy;
  }

  static #line({ instanceLocation, error }: OutputUnit): string {
    return `${instanceLocation.replace(/^#/, '') || '/'} ${error}`;
  }
}
