import type { Weighted } from '../scoring/scorecard-scorer.ts';
import type { Label } from './label.ts';

// What one test gives the scorers of labels: its expected labels and its
// weight. One label is a set of one label, so a class (multiclass) and a set
// of classes (multilabel) are one model.
export class LabelCase implements Weighted {
  readonly expected: ReadonlySet<Label>;
  readonly weight: number;

  constructor({
    expected,
    weight,
  }: {
    readonly expected: Label | readonly Label[];
    readonly weight: number;
  }) {
    this.expected = new Set(
      typeof expected === 'object' ? expected : [expected],
    );
    this.weight = weight;
  }
}
