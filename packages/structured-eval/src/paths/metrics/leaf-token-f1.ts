import { type JsonData, PYTHON_SPACE, PYTHON_WORD } from '@zukhruf/python';

import { pythonStr } from '../cpython/python-text.ts';
import type { JsonPair } from '../json-pair.ts';
import { LeafMean } from './leaf-mean.ts';

// The mean token F1 of each expected leaf and the stated value at its path
// (mean_token_f1), and whenNoneExpected when the expected value has no leaf
// (evaluate.py gives 1). A leaf where neither value has a word gives
// whenNoWords (evaluate.py gives 1), and a path that the stated value does
// not have is read as absentAs (evaluate.py reads None).
export class LeafTokenF1 extends LeafMean {
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

  readonly #whenNoWords: number;
  readonly #absentAs: JsonData;

  constructor({
    whenNoneExpected,
    whenNoWords,
    absentAs,
  }: {
    readonly whenNoneExpected: number;
    readonly whenNoWords: number;
    readonly absentAs: JsonData;
  }) {
    super(whenNoneExpected);
    this.#whenNoWords = whenNoWords;
    this.#absentAs = absentAs;
  }

  protected leaves({
    expectedLeaves,
  }: JsonPair): ReadonlyMap<string, JsonData> {
    return expectedLeaves;
  }

  protected leafValue(
    path: string,
    value: JsonData,
    { statedLeaves }: JsonPair,
  ): number {
    const stated = statedLeaves.get(path);
    return this.#tokenF1(value, stated === undefined ? this.#absentAs : stated);
  }

  // token_f1 of evaluate.py, with its arithmetic: precision and recall first,
  // then 2·p·r/(p + r).
  #tokenF1(expected: JsonData, stated: JsonData): number {
    const expectedWords = LeafTokenF1.#normalizeTokens(expected);
    const statedWords = LeafTokenF1.#normalizeTokens(stated);
    if (expectedWords.length === 0 && statedWords.length === 0)
      return this.#whenNoWords;
    if (expectedWords.length === 0 || statedWords.length === 0) return 0;
    const statedCounts = LeafTokenF1.#counts(statedWords);
    let overlap = 0;
    for (const [word, count] of LeafTokenF1.#counts(expectedWords))
      overlap += Math.min(count, statedCounts.get(word) ?? 0);
    if (overlap === 0) return 0;
    const precision = overlap / statedWords.length;
    const recall = overlap / expectedWords.length;
    return (2 * precision * recall) / (precision + recall);
  }

  // normalize_tokens of evaluate.py: str() of the value, lower case,
  // punctuation and the articles a, an, the as spaces, then the words.
  static #normalizeTokens(value: JsonData): string[] {
    return LeafTokenF1.#text(value)
      .toLowerCase()
      .replaceAll(LeafTokenF1.#punctuation, ' ')
      .replaceAll(LeafTokenF1.#articles, ' ')
      .split(LeafTokenF1.#spaces)
      .filter((word) => word !== '');
  }

  // str() of a leaf, with None and bool as evaluate.py names them. A leaf is
  // never a list or a dict (flatten_leaf_paths).
  static #text(value: JsonData): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value instanceof Map || Array.isArray(value))
      throw new TypeError('A list or a dict is not a leaf.');
    return pythonStr(value);
  }

  static #counts(words: readonly string[]): Map<string, number> {
    const counter = new Map<string, number>();
    for (const word of words) counter.set(word, (counter.get(word) ?? 0) + 1);
    return counter;
  }
}
