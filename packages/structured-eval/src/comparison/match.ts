import type { JsonData } from '@zukhruf/python';

// Says if a stated item and an expected item of a set array can be a pair,
// such as two offers whose quotes are the same sentence.
export interface Match {
  canPair(stated: JsonData, expected: JsonData): boolean;
}
