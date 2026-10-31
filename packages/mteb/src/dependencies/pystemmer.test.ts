import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Stemmer } from './pystemmer.ts';

test('a word with more distinct characters outside the BMP than free private use characters throws, naming the limit', () => {
  const word = Array.from({ length: 6401 }, (_, index) =>
    String.fromCodePoint(0x20000 + index),
  ).join('');

  assert.throws(() => new Stemmer('english').stemWord(word), {
    name: 'RangeError',
    message:
      'A word to stem holds more distinct characters outside the Basic Multilingual Plane than the 6400 private use characters (U+E000 to U+F8FF) that it does not hold.',
  });
});

test('a word with as many distinct characters outside the BMP as free private use characters keeps them in its stem', () => {
  const word = Array.from({ length: 6400 }, (_, index) =>
    String.fromCodePoint(0x20000 + index),
  ).join('');

  assert.equal(new Stemmer('english').stemWord(word), word);
});
