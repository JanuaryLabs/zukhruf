import type { JsonData } from '@zukhruf/python';

import type { JsonPair } from '../json-pair.ts';
import { LeafMean } from './leaf-mean.ts';

// The expected leaf paths that the stated value has, of all expected leaf
// paths, and whenNoneExpected when the expected value has no leaf
// (evaluate.py's ratio gives 0).
export class PathRecall extends LeafMean {
  constructor({ whenNoneExpected }: { readonly whenNoneExpected: number }) {
    super(whenNoneExpected);
  }

  protected leaves({
    expectedLeaves,
  }: JsonPair): ReadonlyMap<string, JsonData> {
    return expectedLeaves;
  }

  protected leafValue(
    path: string,
    _value: JsonData,
    { statedLeaves }: JsonPair,
  ): number {
    return statedLeaves.has(path) ? 1 : 0;
  }
}
