import type { LeafValue } from '../leaf-pair.ts';
import { normalized } from './normalized.ts';
import { TypedComparator } from './typed-comparator.ts';

// Two texts agree when they are the same after Unicode NFKC, lower case, and
// one space between words.
export class NormalizedText extends TypedComparator<string> {
  protected accepts(value: LeafValue): value is string {
    return typeof value === 'string';
  }

  protected compare(stated: string, expected: string): boolean {
    return normalized(stated) === normalized(expected);
  }
}
