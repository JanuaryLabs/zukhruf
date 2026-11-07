import type { Comparison } from '../comparison/comparison.ts';
import { Penalty } from './penalty.ts';

// The penalty whose factor is 1 when the comparison holds what the gate
// checks, else 0. A subclass says what it checks and why a comparison fails
// it (Template Method), so a ScorerSet makes a check of each gate.
export abstract class Gate extends Penalty {
  abstract holds(comparison: Comparison): boolean;

  // Why the comparison fails the gate, for a comparison that fails it.
  abstract explain(comparison: Comparison): string;

  factor(comparison: Comparison): number {
    return this.holds(comparison) ? 1 : 0;
  }
}
