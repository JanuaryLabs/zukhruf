import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { isErrno } from './errno.ts';

describe('isErrno', () => {
  test('a Node.js system error matches its own error code only', async () => {
    // Arrange
    const error = await readFile('/no/such/zukhruf/file').catch(
      (failure: unknown) => failure,
    );

    // Act
    const matches = [isErrno(error, 'ENOENT'), isErrno(error, 'EACCES')];

    // Assert
    assert.deepEqual(matches, [true, false]);
  });

  test('a value that is not an error with a code never matches', () => {
    // Arrange
    const values: unknown[] = [
      new Error('no code'),
      { code: 'ENOENT' },
      'ENOENT',
      undefined,
    ];

    // Act
    const matches = values.map((value) => isErrno(value, 'ENOENT'));

    // Assert
    assert.deepEqual(matches, [false, false, false, false]);
  });
});
