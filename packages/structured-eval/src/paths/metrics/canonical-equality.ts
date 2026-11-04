import { canonicalJson } from '../cpython/python-text.ts';
import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// 1 when the canonical JSON of the stated value (sorted keys, no spaces)
// equals that of the expected value, else 0. No gate.
export class CanonicalEquality implements Metric {
  of({ candidate, testCase }: JsonPair): number {
    return canonicalJson(candidate) === canonicalJson(testCase.expected)
      ? 1
      : 0;
  }
}
