import type { JsonData } from '@zukhruf/python';

import type { Alignment, Pairs } from '../alignment.ts';

// An ordered array: item 0 pairs with item 0, item 1 with item 1, and so on.
// It is the default, and SOB's rule (evaluate.py writes the path of an item
// with its index).
export class ByPosition implements Alignment {
  pairs(stated: readonly JsonData[], expected: readonly JsonData[]): Pairs {
    return Array.from(
      { length: Math.min(stated.length, expected.length) },
      (_, index) => [index, index] as const,
    );
  }
}
