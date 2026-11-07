import type { Comparator } from '../comparator.ts';
import type { LeafValue } from '../leaf-pair.ts';

// A comparator of the leaves of one type: two leaves agree only when both
// have the type, and the subclass agrees on them (Template Method).
export abstract class TypedComparator<
  T extends LeafValue,
> implements Comparator {
  protected abstract accepts(value: LeafValue): value is T;

  protected abstract compare(stated: T, expected: T): boolean;

  agrees(stated: LeafValue, expected: LeafValue): boolean {
    return (
      this.accepts(stated) &&
      this.accepts(expected) &&
      this.compare(stated, expected)
    );
  }
}
