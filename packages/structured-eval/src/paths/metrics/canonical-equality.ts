import { canonicalJson } from '../cpython/python-text.ts';
import type { JsonPair } from '../json-pair.ts';
import { Gate } from './gate.ts';

// 1 when the canonical JSON of the stated value (sorted keys, no spaces)
// equals that of the expected value, else 0. SOB puts no gate on it.
export class CanonicalEquality extends Gate {
  protected holds({ candidate, testCase }: JsonPair): boolean {
    return canonicalJson(candidate) === canonicalJson(testCase.expected);
  }
}
