import type { Weighted } from './scorecard-scorer.ts';

// Compares a stated answer with its case and gives the input of the scorers
// of a family (Strategy), once for each answer.
export interface Comparer<Case extends Weighted, Input> {
  compare(stated: unknown, testCase: Case): Input;
}
