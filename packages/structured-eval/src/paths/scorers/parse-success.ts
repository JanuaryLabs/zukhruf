import type { JsonPair } from '../json-pair.ts';
import { Gate } from './gate.ts';

// 1 when the stated value is a JSON object or array, else 0.
export class ParseSuccess extends Gate {
  protected holds(pair: JsonPair): boolean {
    return pair.parsed;
  }
}
