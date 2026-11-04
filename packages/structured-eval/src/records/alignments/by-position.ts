import type { Alignment, Pairs } from '../alignment.ts';

// An ordered array: the items pair by position.
export class ByPosition implements Alignment {
  pairs(stated: readonly unknown[], expected: readonly unknown[]): Pairs {
    return Array.from(
      { length: Math.min(stated.length, expected.length) },
      (_, index) => [index, index] as const,
    );
  }
}
