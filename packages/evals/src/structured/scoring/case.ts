import type { JsonData } from '@zukhruf/python';

import type { Weighted } from '../../scoring/scorecard-scorer.ts';
import type { JsonSchema } from '../schema/json-schema.ts';

// What one test gives the scorers besides the stated value: the expected
// value, its JSON Schema when the scorers need one, and the weight of the
// test. A case reader reads it from the plain object of a runner.
export class Case implements Weighted {
  readonly expected: JsonData;
  readonly schema: JsonSchema | undefined;
  readonly weight: number;

  constructor({
    expected,
    schema,
    weight,
  }: {
    readonly expected: JsonData;
    readonly schema?: JsonSchema;
    readonly weight: number;
  }) {
    this.expected = expected;
    this.schema = schema;
    this.weight = weight;
  }
}
