import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// 1 when the case's JSON Schema is a valid Draft 7 schema, else 0.
export class ValidSchema implements Metric {
  of(pair: JsonPair): number {
    return pair.testCase.schema.valid ? 1 : 0;
  }
}
