import { Penalty } from './penalty.ts';

// The penalty whose factor is 1 when the input holds what the gate checks,
// else 0. A subclass says what it checks and why an input fails it (Template
// Method), so a ScorerSet makes a check of each gate.
export abstract class Gate<Input> extends Penalty<Input> {
  abstract holds(input: Input): boolean;

  // Why the input fails the gate, for an input that fails it.
  abstract explain(input: Input): string;

  factor(input: Input): number {
    return this.holds(input) ? 1 : 0;
  }
}
