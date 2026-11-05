import { Words } from '../words.ts';
import { TypedComparator } from './typed-comparator.ts';

export class TokenOverlapAtLeast extends TypedComparator<string> {
  readonly #threshold: number;

  constructor(threshold: number) {
    super();
    this.#threshold = threshold;
  }

  protected accepts(value: unknown): value is string {
    return typeof value === 'string';
  }

  protected compare(stated: string, expected: string): boolean {
    return Words.of(stated).f1(Words.of(expected)) >= this.#threshold;
  }
}
