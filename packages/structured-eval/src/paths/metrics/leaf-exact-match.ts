import { pythonEquals } from '../cpython/python-equals.ts';
import type { JsonPair } from '../json-pair.ts';
import type { JsonData } from '../json-value.ts';
import { LeafMean } from './leaf-mean.ts';

// The expected leaves whose path the stated value has with an equal value
// (Python ==), of all expected leaves; 1 without any (exact_match_ratio).
export class LeafExactMatch extends LeafMean {
  protected readonly whenNone = 1;

  protected leaves({
    expectedLeaves,
  }: JsonPair): ReadonlyMap<string, JsonData> {
    return expectedLeaves;
  }

  protected leafValue(
    path: string,
    value: JsonData,
    { statedLeaves }: JsonPair,
  ): number {
    const stated = statedLeaves.get(path);
    return stated !== undefined && pythonEquals(value, stated) ? 1 : 0;
  }
}
