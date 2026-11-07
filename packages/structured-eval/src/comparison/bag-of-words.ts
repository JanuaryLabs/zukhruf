import { PYTHON_SPACE, PYTHON_WORD } from '@zukhruf/python';

import { Counts } from '../aggregation/counts.ts';
import { pythonStr } from '../cpython/python-text.ts';
import type { LeafValue } from './leaf-pair.ts';

// The words of a leaf, each with how often it occurs, as SQuAD's
// normalize_answer reads them: str() of the value, lower case, punctuation
// and the articles a, an, the as spaces, then the runs of Python's \w
// (normalize_tokens of SOB's evaluate.py).
export class BagOfWords {
  static readonly #punctuation = new RegExp(
    `[^${PYTHON_WORD}${PYTHON_SPACE}]`,
    'gu',
  );
  // Python's \b is a border between \w and not \w; JavaScript's \b knows only
  // ASCII words.
  static readonly #articles = new RegExp(
    `(?<![${PYTHON_WORD}])(?:a|an|the)(?![${PYTHON_WORD}])`,
    'gu',
  );
  static readonly #spaces = new RegExp(`[${PYTHON_SPACE}]+`, 'u');

  readonly size: number;
  readonly #counts: ReadonlyMap<string, number>;

  private constructor(words: readonly string[]) {
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    this.size = words.length;
    this.#counts = counts;
  }

  static of(value: LeafValue): BagOfWords {
    return new BagOfWords(
      BagOfWords.#text(value)
        .toLowerCase()
        .replaceAll(BagOfWords.#punctuation, ' ')
        .replaceAll(BagOfWords.#articles, ' ')
        .split(BagOfWords.#spaces)
        .filter((word) => word !== ''),
    );
  }

  // The words that this expected bag shares with a stated bag, as often as
  // both have them (Counter & Counter), with the size of each bag.
  shared(stated: BagOfWords): Counts {
    let hits = 0;
    for (const [word, count] of this.#counts)
      hits += Math.min(count, stated.#counts.get(word) ?? 0);
    return new Counts({ hits, stated: stated.size, expected: this.size });
  }

  // str() of a leaf, with None and bool as evaluate.py names them.
  static #text(value: LeafValue): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return pythonStr(value);
  }
}
