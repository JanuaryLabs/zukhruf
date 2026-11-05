import type { JsonPair } from '../json-pair.ts';
import { Gate } from './gate.ts';

// 1 when the stated value is parsed and agrees with a valid schema, else 0.
export class SchemaCompliance extends Gate {
  protected holds(pair: JsonPair): boolean {
    return pair.compliant;
  }
}
