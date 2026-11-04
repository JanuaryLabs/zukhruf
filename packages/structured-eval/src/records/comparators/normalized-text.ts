import type { Comparator } from '../comparator.ts';
import { normalized } from '../normalized.ts';

export class NormalizedText implements Comparator {
  agrees(stated: unknown, expected: unknown): boolean {
    return (
      typeof stated === 'string' &&
      typeof expected === 'string' &&
      normalized(stated) === normalized(expected)
    );
  }
}
