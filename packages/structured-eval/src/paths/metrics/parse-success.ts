import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// 1 when the stated value is a JSON object or array, else 0.
export class ParseSuccess implements Metric {
  of(pair: JsonPair): number {
    return pair.parsed ? 1 : 0;
  }
}
