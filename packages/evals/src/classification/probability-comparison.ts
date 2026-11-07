import type { Label } from './label.ts';

// The stated probability of each class of one answer, and the expected
// label of its case.
export class ProbabilityComparison {
  readonly probabilities: ReadonlyMap<Label, number>;
  readonly expected: Label;

  constructor({
    probabilities,
    expected,
  }: {
    readonly probabilities: ReadonlyMap<Label, number>;
    readonly expected: Label;
  }) {
    this.probabilities = probabilities;
    this.expected = expected;
  }
}
