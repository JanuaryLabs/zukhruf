import type { Label } from './label.ts';

// The stated labels of one answer, the expected labels of its case, and the
// class set: the classes of the task, in the order that the caller gives
// (scikit-learn's labels). A label outside the class set counts in no class.
export class LabelComparison {
  readonly stated: ReadonlySet<Label>;
  readonly expected: ReadonlySet<Label>;
  readonly #labels: readonly Label[];

  constructor({
    stated,
    expected,
    labels,
  }: {
    readonly stated: ReadonlySet<Label>;
    readonly expected: ReadonlySet<Label>;
    readonly labels: readonly Label[];
  }) {
    this.stated = stated;
    this.expected = expected;
    this.#labels = labels;
  }

  // The class set, in the order that the caller gives.
  labels(): Label[] {
    return [...this.#labels];
  }

  // The comparison of one class: its class set is [label], and each side
  // keeps the label when it has it.
  only(label: Label): LabelComparison {
    const one = new Set([label]);
    return new LabelComparison({
      stated: this.stated.intersection(one),
      expected: this.expected.intersection(one),
      labels: [label],
    });
  }
}
