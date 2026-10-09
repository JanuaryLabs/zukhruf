import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { safeFileName } from './index.ts';

/** The digest that names a long key: SHA-256 of its UTF-16 code units, in lowercase hex. */
function digestOf(key: string): string {
  return createHash('sha256').update(Buffer.from(key, 'utf16le')).digest('hex');
}

describe('safeFileName', () => {
  test('a short key that is not well-formed Unicode gets the hashed name', () => {
    // Arrange: a lone surrogate has no URI encoding.
    const key = 'job\uD800';

    // Act
    const name = safeFileName(key, '.lock'.length);

    // Assert
    assert.equal(name, `job%EF%BF%BD%%${digestOf(key)}`);
  });

  test('two different lone surrogates get different names', () => {
    // Arrange: both become U+FFFD when made well-formed.
    const keys = ['\uD800', '\uDC00'];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    assert.deepEqual(names, [
      '%EF%BF%BD%%205022e3428b7c8276cf247b36e4e512db5651e5cb3472c253d9ee893a8ac750',
      '%EF%BF%BD%%d63ddb2bdab1f3ff8d05c2e27b763c45e9aecc16dfa5265d4825d9e2fbc2e229',
    ]);
  });

  test('a key that fits keeps its encoded name with each dot encoded', () => {
    // Arrange: earlier versions gave these names, and their processes share the files.
    const keys = ['orders/حساب.v2', '.', '..'];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    assert.deepEqual(names, [
      'orders%2F%D8%AD%D8%B3%D8%A7%D8%A8%2Ev2',
      '%2E',
      '%2E%2E',
    ]);
  });

  test('a key that ends with a suffix never gets the name of a shorter key plus that suffix', () => {
    // Arrange
    const suffix = '.lock';

    // Act
    const withSuffix = safeFileName('job.lock', suffix.length);
    const shorterPlusSuffix = safeFileName('job', suffix.length) + suffix;

    // Assert
    assert.notEqual(withSuffix, shorterPlusSuffix);
  });

  test('the longest key that fits keeps its name, and one more character gets the hashed name', () => {
    // Arrange: 250 characters plus a suffix of 5 fill a 255-character file name.
    const longest = 'k'.repeat(250);
    const tooLong = 'k'.repeat(251);

    // Act
    const names = [longest, tooLong].map((key) => safeFileName(key, 5));

    // Assert
    assert.deepEqual(names, [
      longest,
      `${'k'.repeat(32)}%%${digestOf(tooLong)}`,
    ]);
  });

  test('the start of a hashed name never ends in a part of an escape', () => {
    // Arrange: 32 characters cut the sixth `%D8%AD` after `%D`, or after `%` when one `a` comes first.
    const keys = ['ح'.repeat(50), `a${'ح'.repeat(50)}`];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    assert.deepEqual(names, [
      `${'%D8%AD'.repeat(5)}%%${digestOf(keys[0]!)}`,
      `a${'%D8%AD'.repeat(5)}%%${digestOf(keys[1]!)}`,
    ]);
  });

  test('a name plus the longest suffix never passes 255 characters', () => {
    // Arrange
    const longestSuffix = 13;
    const keys = [
      'k'.repeat(10_000),
      'ح'.repeat(10_000),
      '\uD800'.repeat(10_000),
      'k'.repeat(255 - longestSuffix),
      'k'.repeat(256 - longestSuffix),
    ];

    // Act
    const lengths = keys.map(
      (key) => safeFileName(key, longestSuffix).length + longestSuffix,
    );

    // Assert
    assert.ok(
      lengths.every((length) => length <= 255),
      `Each length must be at most 255, got ${lengths.join(', ')}`,
    );
  });

  test('a key spelled like a hashed name does not get that hashed name', () => {
    // Arrange
    const hashed = safeFileName('k'.repeat(251), 5);

    // Act
    const name = safeFileName(hashed, 5);

    // Assert
    assert.notEqual(name, hashed);
  });
});
