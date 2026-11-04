import type { JsonData } from '../json-value.ts';
import { pythonStr } from './python-text.ts';

// Python's \s and str.split() whitespace (str.isspace). A probe over every
// code point proved this class and [\p{L}\p{N}_] (Python's \w) equal to
// Python's for each character that Python's Unicode database has; Node also
// knows characters of later Unicode versions, which Python reads as not \w.
const SPACE = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`;
const WORD = String.raw`\p{L}\p{N}_`;
const PUNCTUATION = new RegExp(`[^${WORD}${SPACE}]`, 'gu');
// Python's \b is a border between \w and not \w; JavaScript's \b knows only
// ASCII words.
const ARTICLES = new RegExp(`(?<![${WORD}])(?:a|an|the)(?![${WORD}])`, 'gu');
const SPACES = new RegExp(`[${SPACE}]+`, 'u');

// normalize_tokens of evaluate.py: str() of the value, lower case,
// punctuation and the articles a, an, the as spaces, then the words.
export function normalizeTokens(value: JsonData | undefined): string[] {
  const text =
    value === null || value === undefined
      ? 'null'
      : typeof value === 'boolean'
        ? value
          ? 'true'
          : 'false'
        : typeof value === 'object'
          ? ''
          : pythonStr(value);
  return text
    .toLowerCase()
    .replaceAll(PUNCTUATION, ' ')
    .replaceAll(ARTICLES, ' ')
    .split(SPACES)
    .filter((word) => word !== '');
}

const counts = (words: readonly string[]) => {
  const counter = new Map<string, number>();
  for (const word of words) counter.set(word, (counter.get(word) ?? 0) + 1);
  return counter;
};

// token_f1 of evaluate.py, with its arithmetic: precision and recall first,
// then 2·p·r/(p + r).
export function tokenF1(
  expected: JsonData | undefined,
  stated: JsonData | undefined,
): number {
  const expectedWords = normalizeTokens(expected);
  const statedWords = normalizeTokens(stated);
  if (expectedWords.length === 0 && statedWords.length === 0) return 1;
  if (expectedWords.length === 0 || statedWords.length === 0) return 0;
  const statedCounts = counts(statedWords);
  let overlap = 0;
  for (const [word, count] of counts(expectedWords))
    overlap += Math.min(count, statedCounts.get(word) ?? 0);
  if (overlap === 0) return 0;
  const precision = overlap / statedWords.length;
  const recall = overlap / expectedWords.length;
  return (2 * precision * recall) / (precision + recall);
}
