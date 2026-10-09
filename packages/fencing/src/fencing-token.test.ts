import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FencingToken } from './index.ts';

describe('FencingToken.parse', () => {
  for (const text of [
    '',
    '-1',
    '+1',
    ' 1',
    '1 ',
    '1\n',
    '1.0',
    '1e3',
    '0x10',
    '١',
    'abc',
  ]) {
    test(`refuses ${JSON.stringify(text)}, which is not a token's text`, () => {
      // Act
      const token = FencingToken.parse(text);

      // Assert
      assert.equal(token, null);
    });
  }

  for (const value of [
    0n,
    1n,
    (5n << 32n) | 1n,
    (1n << 63n) - 1n,
    (1n << 64n) + 1n,
  ]) {
    test(`reads back the text of token ${value}`, () => {
      // Arrange
      const text = new FencingToken(value).toString();

      // Act
      const token = FencingToken.parse(text);

      // Assert
      assert.equal(token?.value, value);
    });
  }
});

describe('FencingToken order', () => {
  test('an equal or a lower token is not newer', () => {
    // Arrange
    const token = new FencingToken(1n << 60n);

    // Act
    const equal = new FencingToken(1n << 60n).isNewerThan(token);
    const lower = new FencingToken((1n << 60n) - 1n).isNewerThan(token);

    // Assert
    assert.equal(equal, false);
    assert.equal(lower, false);
  });

  test('a token one above another is newer, also above 2^53', () => {
    // Arrange: 2^60 and 2^60 + 1 are the same JavaScript number.
    const token = new FencingToken(1n << 60n);

    // Act
    const higher = new FencingToken((1n << 60n) + 1n).isNewerThan(token);

    // Assert
    assert.equal(higher, true);
  });
});
