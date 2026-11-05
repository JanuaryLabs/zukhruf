import { RatioOfSums } from '../../aggregation/ratio-of-sums.ts';
import { Ratio } from '../../aggregation/ratio.ts';
import type { Measure, NamedRatio } from '../measure.ts';
import type { Leaf, RecordVisitor } from '../record-visitor.ts';
import { hasValue } from '../values.ts';
import { Words } from '../words.ts';

// Partial credit for text: each expected value gets the F1 of the words that
// its stated value shares with it, and a missing value gets 0. `token f1` is
// the credit divided by the expected values: a ratio of sums, so the credit
// adds up with CPython's sum, as every average of the package does (ADR 0004).
export class TokenCredit implements Measure, RecordVisitor {
  readonly #total = new RatioOfSums();
  readonly #fields = new Map<string, RatioOfSums>();

  leaf(leaf: Leaf): void {
    if (!hasValue(leaf.expected)) return;
    const credit = hasValue(leaf.stated)
      ? Words.of(TokenCredit.#text(leaf.stated)).f1(
          Words.of(TokenCredit.#text(leaf.expected)),
        )
      : 0;
    const ratio = new Ratio(credit, 1);
    this.#total.add(ratio);
    this.#fields
      .getOrInsertComputed(leaf.field, () => new RatioOfSums())
      .add(ratio);
  }

  *ratios(): Generator<NamedRatio> {
    yield ['token f1', this.#total.ratio];
    for (const [name, field] of this.#fields)
      yield [`${name} token f1`, field.ratio];
  }

  static #text(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
}
