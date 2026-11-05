import { tokenF1 } from '../cpython/python-tokens.ts';
import type { JsonPair } from '../json-pair.ts';
import type { JsonData } from '../json-value.ts';
import { LeafMean } from './leaf-mean.ts';

// The mean token F1 of each expected leaf and the stated value at its path
// (None when absent); 1 without any expected leaf (mean_token_f1).
export class LeafTokenF1 extends LeafMean {
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
    return tokenF1(value, statedLeaves.get(path) ?? null);
  }
}
