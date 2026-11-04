import { pythonEquals } from '../cpython/python-equals.ts';
import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// The expected leaves whose path the stated value has with an equal value
// (Python ==), of all expected leaves; 1 without any (exact_match_ratio).
export class LeafExactMatch implements Metric {
  of({ expectedLeaves, statedLeaves }: JsonPair): number {
    if (expectedLeaves.size === 0) return 1;
    let matches = 0;
    for (const [path, value] of expectedLeaves) {
      const stated = statedLeaves.get(path);
      if (stated !== undefined && pythonEquals(value, stated)) matches++;
    }
    return matches / expectedLeaves.size;
  }
}
