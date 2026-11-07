import type { CaseReader } from '../../scoring/scorecard-scorer.ts';
import { JsonValue } from '../comparison/json-value.ts';
import { JsonSchema } from '../schema/json-schema.ts';
import { Case } from './case.ts';

// Reads a case from the vars of a test (Strategy): vars.expected as JSON
// text, without loss, as json.loads reads it, so `7.0` stays a float; a
// runner that parses its rows, as promptfoo does, has already turned `7.0`
// into `7` in a JavaScript value. vars.schema is a JSON value: promptfoo
// resolves the `$ref` of a row to one (ADR 0006). The reader builds the
// JsonSchema of each case from it with the function that it is given, which
// sets the draft. A row without a weight weighs 1.
export class TextVarsCase implements CaseReader<Case> {
  readonly #schema: (value: JsonValue) => JsonSchema;

  constructor({
    schema = (value) => new JsonSchema(value),
  }: { readonly schema?: (value: JsonValue) => JsonSchema } = {}) {
    this.#schema = schema;
  }

  from(vars: Readonly<Record<string, unknown>>): Case {
    const { expected, schema, weight } = vars;
    if (typeof expected !== 'string')
      throw new Error(
        'A text vars case needs vars.expected as JSON text, the expected value',
      );
    if (weight !== undefined && typeof weight !== 'number')
      throw new Error(`vars.weight is a number, not ${JSON.stringify(weight)}`);
    return new Case({
      expected: JsonValue.parse(expected).value,
      ...(schema === undefined
        ? {}
        : { schema: this.#schema(JsonValue.from(schema)) }),
      weight: weight ?? 1,
    });
  }
}
