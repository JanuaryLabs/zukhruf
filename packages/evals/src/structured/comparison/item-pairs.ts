import type { Field } from './field.ts';

// The items of one array of one comparison: how many each side has, and how
// many pairs its alignment made. A side that has no array at the path has 0
// items.
export type ItemPairs = {
  readonly field: Field;
  readonly expected: number;
  readonly stated: number;
  readonly paired: number;
};
