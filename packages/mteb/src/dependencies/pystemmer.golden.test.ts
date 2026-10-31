import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Stemmer } from './pystemmer.ts';

// fixtures/snowball/expected.json holds what PyStemmer 3.1.0 (the C stemmers
// of libstemmer_c 3.1.0) gave: the stem of each word of a word list for each
// algorithm, the sha256 of the stems of a probe list for each name of an
// algorithm, and the errors of names that it refuses. generate.py makes it.
type Expected = {
  readonly probe: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
  readonly errors: readonly [
    name: string,
    error: 'KeyError' | 'UnicodeEncodeError',
    message: string,
  ][];
  readonly stems: Readonly<Record<string, readonly [string, string][]>>;
};

const expected: Expected = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/snowball/expected.json'),
    'utf8',
  ),
);

for (const [algorithm, pairs] of Object.entries(expected.stems)) {
  test(`each word has the stem that PyStemmer 3.1.0 gives with ${algorithm}`, () => {
    const stemmer = new Stemmer(algorithm);

    const stems = stemmer.stemWords(pairs.map(([word]) => word));

    assert.deepEqual(
      pairs.map(([word], index) => [word, stems[index]]),
      pairs,
    );
  });
}

test('each name and alias of libstemmer stems the probe words as in PyStemmer', () => {
  const hashes = Object.fromEntries(
    Object.keys(expected.aliases).map((name) => [
      name,
      createHash('sha256')
        .update(new Stemmer(name).stemWords(expected.probe).join('\n'))
        .digest('hex'),
    ]),
  );

  assert.deepEqual(hashes, expected.aliases);
});

test('a name that PyStemmer refuses throws its error', () => {
  const errors = expected.errors.map(([name]) => {
    try {
      new Stemmer(name);
    } catch (error) {
      assert.ok(error instanceof Error);
      return [
        name,
        error instanceof RangeError ? 'UnicodeEncodeError' : 'KeyError',
        error.message,
      ];
    }
    return [name, 'none', ''];
  });

  assert.deepEqual(errors, expected.errors);
});
