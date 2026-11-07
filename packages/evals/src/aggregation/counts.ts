// The counts of one comparison that precision, recall and F1 read: the hits,
// the stated values and the expected values (scikit-learn's tp, tp + fp and
// tp + fn).
export class Counts {
  readonly hits: number;
  readonly stated: number;
  readonly expected: number;

  constructor({
    hits,
    stated,
    expected,
  }: {
    readonly hits: number;
    readonly stated: number;
    readonly expected: number;
  }) {
    this.hits = hits;
    this.stated = stated;
    this.expected = expected;
  }
}
