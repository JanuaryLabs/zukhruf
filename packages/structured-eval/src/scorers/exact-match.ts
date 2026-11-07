import type { Comparison } from '../comparison/comparison.ts';
import { canonicalJson } from '../cpython/python-text.ts';
import { Gate } from './gate.ts';

// 1 when the canonical JSON of the stated value (sorted keys, no spaces)
// equals that of the expected value, else 0. SOB puts no gate on it.
export class ExactMatch extends Gate {
  holds({ stated, case: testCase }: Comparison): boolean {
    return canonicalJson(stated) === canonicalJson(testCase.expected);
  }

  explain(): string {
    return 'the canonical JSON of the stated value is not that of the expected value';
  }
}
