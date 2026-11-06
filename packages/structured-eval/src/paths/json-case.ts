import { type JsonData, loadsJson } from '@zukhruf/python';

import type { Weighted } from '../scoring/scorecard-scorer.ts';
import { Draft7Schema } from './draft7-schema.ts';

// A JavaScript value as json.loads reads its JSON text: an integral number
// becomes an int. JSON.stringify gives no text for undefined, which stands
// for no value (None).
export const fromJavaScript = (value: unknown): JsonData =>
  value === undefined ? null : loadsJson(JSON.stringify(value));

// What one test gives the scorers: the expected value, its JSON Schema, and
// the weight of the test.
export class JsonCase implements Weighted {
  readonly expected: JsonData;
  readonly schema: Draft7Schema;
  readonly weight: number;

  constructor(expected: JsonData, schema: JsonData, weight: number) {
    this.expected = expected;
    this.schema = new Draft7Schema(schema);
    this.weight = weight;
  }

  // The config of a test row: { expected, schema, weight? }, as JavaScript
  // values, so an integral float such as 7.0 is already 7; JsonTextCase reads
  // them as JSON text instead. A row without a weight weighs 1, so its mean
  // is not weighted.
  static from(config: Readonly<Record<string, unknown>>): JsonCase {
    const { expected, schema, weight } = config;
    if (expected === undefined || schema === undefined)
      throw new Error(
        'A JSON case needs config.expected and config.schema: the expected value and its JSON Schema',
      );
    if (weight !== undefined && typeof weight !== 'number')
      throw new Error(
        `config.weight is a number, not ${JSON.stringify(weight)}`,
      );
    return new JsonCase(
      fromJavaScript(expected),
      fromJavaScript(schema),
      weight ?? 1,
    );
  }
}
