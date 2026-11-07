import type { Label } from './label.ts';

// The weight of each pair of an expected label and a stated label, as
// scikit-learn's confusion_matrix gives it: a row for each expected label and
// a column for each stated label, in the order of the labels.
export class ConfusionMatrix {
  readonly labels: readonly Label[];
  readonly #pairs: ReadonlyMap<Label, ReadonlyMap<Label, number>>;

  constructor(
    labels: readonly Label[],
    pairs: ReadonlyMap<Label, ReadonlyMap<Label, number>>,
  ) {
    this.labels = labels;
    this.#pairs = pairs;
  }

  count(expected: Label, stated: Label): number {
    return this.#pairs.get(expected)?.get(stated) ?? 0;
  }

  rows(): number[][] {
    return this.labels.map((expected) =>
      this.labels.map((stated) => this.count(expected, stated)),
    );
  }
}
