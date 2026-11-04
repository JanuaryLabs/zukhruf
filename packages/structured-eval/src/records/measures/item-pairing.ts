import type { Measure, NamedRatio } from '../measure.ts';
import type { Items, RecordVisitor } from '../record-visitor.ts';
import { Counts } from './counts.ts';

// The items of each array: expected, stated and paired, as the precision,
// recall and F1 of the pairs.
export class ItemPairing implements Measure, RecordVisitor {
  readonly #arrays = new Map<string, Counts>();

  items(items: Items): void {
    const counts = this.#arrays.get(items.field) ?? new Counts();
    this.#arrays.set(items.field, counts);
    counts.expected += items.expected;
    counts.stated += items.stated;
    counts.hits += items.paired;
  }

  get allPaired(): boolean {
    return [...this.#arrays.values()].every((counts) => counts.complete);
  }

  unpaired(): string[] {
    return [...this.#arrays]
      .filter(([, counts]) => !counts.complete)
      .map(
        ([field, counts]) =>
          `${field}: ${counts.hits} pairs of ${counts.expected} expected and ${counts.stated} stated items`,
      );
  }

  *ratios(): Generator<NamedRatio> {
    for (const [field, counts] of this.#arrays)
      yield* counts.ratios(`${field} items `);
  }
}
