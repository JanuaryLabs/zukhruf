import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  STOPWORDS_CHINESE,
  STOPWORDS_DUTCH,
  STOPWORDS_EN,
  STOPWORDS_FRENCH,
  STOPWORDS_GERMAN,
  STOPWORDS_ITALIAN,
  STOPWORDS_NORWEGIAN,
  STOPWORDS_PORTUGUESE,
  STOPWORDS_RUSSIAN,
  STOPWORDS_SPANISH,
  STOPWORDS_SWEDISH,
} from './bm25s-stopwords.ts';

// fixtures/bm25s-stopwords/expected.json holds the 11 lists of bm25s 0.3.16
// that MTEB maps, by MTEB's key. generate.py makes it.
const expected: { readonly lists: Readonly<Record<string, string[]>> } =
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures/bm25s-stopwords/expected.json'),
      'utf8',
    ),
  );

const LISTS = {
  en: STOPWORDS_EN,
  de: STOPWORDS_GERMAN,
  nl: STOPWORDS_DUTCH,
  fr: STOPWORDS_FRENCH,
  es: STOPWORDS_SPANISH,
  pt: STOPWORDS_PORTUGUESE,
  it: STOPWORDS_ITALIAN,
  ru: STOPWORDS_RUSSIAN,
  sv: STOPWORDS_SWEDISH,
  no: STOPWORDS_NORWEGIAN,
  zh: STOPWORDS_CHINESE,
};

test('each stopword list holds the words of bm25s 0.3.16, in its order', () => {
  assert.deepEqual(LISTS, expected.lists);
});
