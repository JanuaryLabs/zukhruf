import { F1Ratio } from '../../../aggregation/f1-ratio.ts';
import { BagOfWords } from '../bag-of-words.ts';
import type { LeafValue } from '../leaf-pair.ts';
import { TypedComparator } from './typed-comparator.ts';

// Two texts agree when the F1 of their shared words, as SQuAD reads words,
// reaches the threshold. Two texts that share no word have the F1 0.
export class TokenOverlapAtLeast extends TypedComparator<string> {
  readonly #threshold: number;

  constructor(threshold: number) {
    super();
    this.#threshold = threshold;
  }

  protected accepts(value: LeafValue): value is string {
    return typeof value === 'string';
  }

  protected compare(stated: string, expected: string): boolean {
    const counts = BagOfWords.of(expected).shared(BagOfWords.of(stated));
    return new F1Ratio(counts).value >= this.#threshold;
  }
}
