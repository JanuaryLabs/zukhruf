import type { Measure, NamedRatio } from '../measure.ts';
import type { Leaf, RecordVisitor } from '../record-visitor.ts';
import { hasValue } from '../values.ts';
import { Counts } from './counts.ts';

// Counts the expected, stated and hit values of each field, and gives their
// precision, recall and F1 for all fields and for each field. A subclass says
// what a hit is and how its ratios are named (Template Method).
export abstract class FieldHits implements Measure, RecordVisitor {
  protected readonly fields = new Map<string, Counts>();

  // Put before the ratio name, such as 'presence ' in 'presence recall'.
  protected abstract readonly label: string;

  protected abstract hit(leaf: Leaf): boolean;

  leaf(leaf: Leaf): void {
    const counts = this.fields.getOrInsertComputed(
      leaf.field,
      () => new Counts(),
    );
    if (hasValue(leaf.expected)) counts.expected++;
    if (hasValue(leaf.stated)) counts.stated++;
    if (this.hit(leaf)) counts.hits++;
  }

  protected get total(): Counts {
    const total = new Counts();
    for (const counts of this.fields.values()) total.add(counts);
    return total;
  }

  *ratios(): Generator<NamedRatio> {
    yield* this.total.ratios(this.label);
    for (const [field, counts] of this.fields)
      yield* counts.ratios(`${field} ${this.label}`);
  }
}
