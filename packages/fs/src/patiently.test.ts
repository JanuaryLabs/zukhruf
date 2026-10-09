import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { patiently } from './patiently.ts';

const offWindows = {
  skip:
    process.platform === 'win32'
      ? 'On Windows, patiently tries a refused file again'
      : false,
};

describe('patiently, off Windows', () => {
  test(
    'an operation runs one time and its value reaches the caller',
    { ...offWindows, timeout: 2_000 },
    async () => {
      // Arrange
      let runs = 0;

      // Act
      const value = await patiently(async () => {
        runs++;
        return 'content';
      });

      // Assert
      assert.equal(value, 'content');
      assert.equal(runs, 1);
    },
  );

  test(
    'an error that Windows uses for a refusal reaches the caller at once and unchanged',
    { ...offWindows, timeout: 2_000 },
    async () => {
      // Arrange
      let runs = 0;
      const refusal = Object.assign(
        new Error('EPERM: operation not permitted'),
        {
          code: 'EPERM',
        },
      );

      // Act
      const running = patiently(async () => {
        runs++;
        throw refusal;
      });

      // Assert
      await assert.rejects(running, (error) => error === refusal);
      assert.equal(runs, 1);
    },
  );
});
