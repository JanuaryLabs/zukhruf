import type { JsonData } from '@zukhruf/python';

import type { Field } from './field.ts';
import type { Path } from './path.ts';

// One element of an array on one side, at its path in that side's value.
export type Item = { readonly path: Path; readonly value: JsonData };

// One stated item and one expected item that the walk compares leaf by leaf.
export type Pair = { readonly stated: Item; readonly expected: Item };

// The items of one array of one comparison: the pairs that its alignment
// made, in the order of the expected items, and the items of each side
// without a pair, in the order of that side. A side that has no array at the
// path has no items, so each item of the other side has no pair.
export class ItemPairs {
  readonly field: Field;
  readonly pairs: readonly Pair[];
  readonly unpairedStated: readonly Item[];
  readonly unpairedExpected: readonly Item[];

  constructor(
    field: Field,
    pairs: readonly Pair[],
    unpairedStated: readonly Item[],
    unpairedExpected: readonly Item[],
  ) {
    this.field = field;
    this.pairs = pairs;
    this.unpairedStated = unpairedStated;
    this.unpairedExpected = unpairedExpected;
  }

  get expected(): number {
    return this.pairs.length + this.unpairedExpected.length;
  }

  get stated(): number {
    return this.pairs.length + this.unpairedStated.length;
  }

  get paired(): number {
    return this.pairs.length;
  }
}
