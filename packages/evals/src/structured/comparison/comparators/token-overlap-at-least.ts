import {
  CountsForm,
  type FMeasureForm,
} from '../../../aggregation/f-measure-form.ts';
import { BagOfWords } from '../bag-of-words.ts';
import type { LeafValue } from '../leaf-pair.ts';
import { TypedComparator } from './typed-comparator.ts';

// Two texts agree when the F1 of their shared words, as SQuAD reads words,
// reaches the threshold. Two texts that share no word have the F1 0. The form
// is the arithmetic of the F1.
export class TokenOverlapAtLeast extends TypedComparator<string> {
  readonly #threshold: number;
  readonly #form: FMeasureForm;

  constructor(
    threshold: number,
    { form = new CountsForm() }: { readonly form?: FMeasureForm } = {},
  ) {
    super();
    this.#threshold = threshold;
    this.#form = form;
  }

  protected accepts(value: LeafValue): value is string {
    return typeof value === 'string';
  }

  protected compare(stated: string, expected: string): boolean {
    const counts = BagOfWords.of(expected).shared(BagOfWords.of(stated));
    return this.#form.of(counts, 1) >= this.#threshold;
  }
}
