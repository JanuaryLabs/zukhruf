import { NeumaierSum } from '@zukhruf/python';

import { F1Ratio } from '../../aggregation/f1-ratio.ts';
import { Ratio } from '../../aggregation/ratio.ts';
import type { Scorer } from '../../scorers/scorer.ts';
import { BagOfWords } from '../comparison/bag-of-words.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { LeafValue } from '../comparison/leaf-pair.ts';
import type { LeafOptions } from './leaf-matches.ts';

// The sum of the token F1 of each expected leaf and the stated value at its
// path, over the expected leaves (mean_token_f1 of evaluate.py). Words are
// read as SQuAD's normalize_answer reads them. A leaf where neither value has
// a word gives whenNoWords (evaluate.py gives 1), and a path that the stated
// value does not have is read as absentAs (evaluate.py reads None). With
// nullIsMissing, a null leaf is no value: an expected null is not counted,
// and a stated null is read as absentAs.
export class TokenF1 implements Scorer<Comparison> {
  readonly #whenNoWords: number;
  readonly #absentAs: LeafValue;
  readonly #nullIsMissing: boolean;

  constructor({
    whenNoWords,
    absentAs,
    nullIsMissing = false,
  }: {
    readonly whenNoWords: number;
    readonly absentAs: LeafValue;
  } & LeafOptions) {
    this.#whenNoWords = whenNoWords;
    this.#absentAs = absentAs;
    this.#nullIsMissing = nullIsMissing;
  }

  score(comparison: Comparison): Ratio {
    // CPython's sum, so the mean of the floats is that of evaluate.py.
    const sum = new NeumaierSum();
    let expected = 0;
    for (const pair of comparison.leaves({
      nullIsMissing: this.#nullIsMissing,
    })) {
      if (pair.expected === undefined) continue;
      expected++;
      sum.add(
        this.#tokenF1(
          pair.expected.value,
          pair.stated === undefined ? this.#absentAs : pair.stated.value,
        ),
      );
    }
    return new Ratio(sum.value, expected);
  }

  // token_f1 of evaluate.py: the F1 of the shared words.
  #tokenF1(expected: LeafValue, stated: LeafValue): number {
    const expectedWords = BagOfWords.of(expected);
    const statedWords = BagOfWords.of(stated);
    if (expectedWords.size === 0 && statedWords.size === 0)
      return this.#whenNoWords;
    return new F1Ratio(expectedWords.shared(statedWords)).value;
  }
}
