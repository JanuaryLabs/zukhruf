import { Ratio } from '../../aggregation/ratio.ts';
import type { Measure, NamedRatio } from '../measure.ts';
import type { Leaf, RecordVisitor } from '../record-visitor.ts';
import { hasValue } from '../values.ts';
import { Words } from '../words.ts';

const text = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value);

// Partial credit for text: each expected value gets the F1 of the words that
// its stated value shares with it, and a missing value gets 0. `token f1` is
// the credit divided by the expected values.
export class TokenCredit implements Measure, RecordVisitor {
  readonly #fields = new Map<string, { expected: number; credit: number }>();

  leaf(leaf: Leaf): void {
    if (!hasValue(leaf.expected)) return;
    const field = this.#fields.get(leaf.field) ?? { expected: 0, credit: 0 };
    this.#fields.set(leaf.field, field);
    field.expected++;
    if (hasValue(leaf.stated))
      field.credit += Words.of(text(leaf.stated)).f1(
        Words.of(text(leaf.expected)),
      );
  }

  *ratios(): Generator<NamedRatio> {
    let expected = 0;
    let credit = 0;
    for (const field of this.#fields.values()) {
      expected += field.expected;
      credit += field.credit;
    }
    yield ['token f1', new Ratio(credit, expected)];
    for (const [name, field] of this.#fields)
      yield [`${name} token f1`, new Ratio(field.credit, field.expected)];
  }
}
