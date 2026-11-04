import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// 1 when the stated value is parsed and agrees with a valid schema, else 0.
export class SchemaCompliance implements Metric {
  of(pair: JsonPair): number {
    return pair.compliant ? 1 : 0;
  }
}
