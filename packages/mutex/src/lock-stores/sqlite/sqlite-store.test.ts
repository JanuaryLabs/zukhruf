import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Mutex } from '../../mutex/mutex.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { SqliteStore } from './sqlite-store.ts';

const openFiles = () => readdirSync('/dev/fd').length;

/** Holds `key` until the returned function is called. */
async function hold(mutex: Mutex, key: string) {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const held = mutex.acquire(key, async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  return async () => {
    finish.resolve();
    await held;
  };
}

describe('SqliteStore', () => {
  test(
    'many callers that wait in one process do not each keep a database file open',
    {
      timeout: 10000,
      skip:
        process.platform === 'win32'
          ? 'Windows has no /dev/fd to count open files'
          : false,
    },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const mutex = new Mutex(
        new SqliteStore(directory.path, { pollInterval: 10 }),
      );
      const release = await hold(mutex, 'report:daily');
      const before = openFiles();

      // Act: fifty callers wait for the held key.
      const waiters = Array.from({ length: 50 }, () =>
        mutex.acquire('report:daily', async () => {}),
      );
      await delay(100);
      const whileWaiting = openFiles();
      await release();
      await Promise.all(waiters);

      // Assert
      assert.ok(
        whileWaiting - before <= 2,
        `Fifty waiters opened ${whileWaiting - before} more files; they must share one database connection`,
      );
    },
  );

  test(
    'callers in one process get the key in the order they asked for it',
    { timeout: 10000 },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const mutex = new Mutex(
        new SqliteStore(directory.path, { pollInterval: 10 }),
      );
      const release = await hold(mutex, 'report:daily');
      const order: number[] = [];

      // Act
      const waiters = [0, 1, 2, 3, 4].map((index) =>
        mutex.acquire('report:daily', async () => {
          order.push(index);
        }),
      );
      await delay(50);
      await release();
      await Promise.all(waiters);

      // Assert
      assert.deepEqual(order, [0, 1, 2, 3, 4]);
    },
  );
});
