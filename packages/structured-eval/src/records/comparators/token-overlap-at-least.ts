import type { Comparator } from '../comparator.ts';
import { Words } from '../words.ts';

export class TokenOverlapAtLeast implements Comparator {
  readonly #threshold: number;

  constructor(threshold: number) {
    this.#threshold = threshold;
  }

  agrees(stated: unknown, expected: unknown): boolean {
    return (
      typeof stated === 'string' &&
      typeof expected === 'string' &&
      Words.of(stated).f1(Words.of(expected)) >= this.#threshold
    );
  }
}
