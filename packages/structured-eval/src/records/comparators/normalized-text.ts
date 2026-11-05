import { normalized } from '../normalized.ts';
import { TypedComparator } from './typed-comparator.ts';

export class NormalizedText extends TypedComparator<string> {
  protected accepts(value: unknown): value is string {
    return typeof value === 'string';
  }

  protected compare(stated: string, expected: string): boolean {
    return normalized(stated) === normalized(expected);
  }
}
