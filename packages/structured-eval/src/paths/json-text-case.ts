import { loadsJson } from './cpython/python-json.ts';
import { JsonCase, fromJavaScript } from './json-case.ts';

// Reads a case whose expected value is JSON text, without loss, as json.loads
// reads it: `7.0` stays a float. A runner that parses its rows, as promptfoo
// does, has already turned `7.0` into `7` in a JavaScript value, so a row that
// needs that difference gives the expected value as text. The schema is a
// JSON value: promptfoo resolves the `$ref` of a row to one (ADR 0006).
export class JsonTextCase {
  static from(values: Readonly<Record<string, unknown>>): JsonCase {
    const { expected, schema, weight } = values;
    if (typeof expected !== 'string')
      throw new Error(
        'A JSON text case needs expected as JSON text, the expected value',
      );
    if (schema === undefined)
      throw new Error(
        'A JSON text case needs schema, the JSON Schema of the expected value',
      );
    if (weight !== undefined && typeof weight !== 'number')
      throw new Error(`weight is a number, not ${JSON.stringify(weight)}`);
    return new JsonCase(
      loadsJson(expected),
      fromJavaScript(schema),
      weight ?? 1,
    );
  }
}
