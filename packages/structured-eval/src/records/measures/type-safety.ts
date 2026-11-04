import { Ratio } from '../../aggregation/ratio.ts';
import type { Measure, NamedRatio } from '../measure.ts';
import type { RecordLeaf } from '../record-leaves.ts';
import type { SchemaTypes } from '../schema/schema-types.ts';

// The stated values whose type is a type that the schema allows at their
// path, divided by all stated values. It reads the stated record as the
// harness gave it, so it also counts the type errors of an invalid record.
export class TypeSafety implements Measure {
  readonly #typed: number;
  readonly #stated: number;

  constructor(types: SchemaTypes, leaves: Iterable<RecordLeaf>) {
    let typed = 0;
    let stated = 0;
    for (const { steps, value } of leaves) {
      stated++;
      if (types.allows(steps, value)) typed++;
    }
    this.#typed = typed;
    this.#stated = stated;
  }

  *ratios(): Generator<NamedRatio> {
    yield ['type safety', new Ratio(this.#typed, this.#stated)];
  }
}
