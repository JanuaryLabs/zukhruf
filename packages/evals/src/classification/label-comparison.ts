import { type Label, compareLabels } from './label.ts';

// The stated labels of one answer and the expected labels of its case.
export class LabelComparison {
  readonly stated: ReadonlySet<Label>;
  readonly expected: ReadonlySet<Label>;

  constructor({
    stated,
    expected,
  }: {
    readonly stated: ReadonlySet<Label>;
    readonly expected: ReadonlySet<Label>;
  }) {
    this.stated = stated;
    this.expected = expected;
  }

  // The labels of both sides, in the order of numpy's unique().
  labels(): Label[] {
    return [...this.stated.union(this.expected)].toSorted(compareLabels);
  }

  // The comparison of one class: each side keeps the label when it has it.
  only(label: Label): LabelComparison {
    const one = new Set([label]);
    return new LabelComparison({
      stated: this.stated.intersection(one),
      expected: this.expected.intersection(one),
    });
  }
}
