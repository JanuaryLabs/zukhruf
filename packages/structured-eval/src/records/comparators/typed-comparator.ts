import type { Comparator } from '../comparator.ts';

// A comparator of the values of one type: two values agree only when both
// have the type, and the subclass agrees on them (Template Method).
export abstract class TypedComparator<T> implements Comparator {
  protected abstract accepts(value: unknown): value is T;

  protected abstract compare(stated: T, expected: T): boolean;

  agrees(stated: unknown, expected: unknown): boolean {
    return (
      this.accepts(stated) &&
      this.accepts(expected) &&
      this.compare(stated, expected)
    );
  }
}
