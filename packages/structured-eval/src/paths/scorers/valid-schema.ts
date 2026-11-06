import type { JsonPair } from '../json-pair.ts';
import { Gate } from './gate.ts';

// 1 when the case's JSON Schema is a valid Draft 7 schema, else 0.
export class ValidSchema extends Gate {
  protected holds(pair: JsonPair): boolean {
    return pair.testCase.schema.valid;
  }
}
