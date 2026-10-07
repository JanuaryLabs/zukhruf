import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Modes } from '../../mutex/acquire-modes/modes.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { isRecord } from '../../shared/is-record.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { newProcessTimeout, waitUntil } from '../../testing/wait-until.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { SqliteStore } from './sqlite-store.ts';

const posixOnly =
  process.platform === 'win32' ? 'Windows has no read-only directories' : false;

const mutexUrl = new URL('../../mutex/mutex.ts', import.meta.url);
const storeUrl = new URL('./sqlite-store.ts', import.meta.url);

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

describe('SqliteStore holder record', () => {
  test(
    'a holder that was killed leaves no file once the next holder took the key and let it go',
    { timeout: 30000 },
    async (t) => {
      // Arrange: a holder process dies while it holds the key.
      await using directory = await scratchDirectory();
      await using holder = startWorker(
        `
				import { Mutex } from ${JSON.stringify(mutexUrl.href)};
				import { SqliteStore } from ${JSON.stringify(storeUrl.href)};
				const mutex = new Mutex(new SqliteStore(${JSON.stringify(directory.path)}));
				setInterval(() => {}, 1000);
				await mutex.acquire('report:daily', async () => {
					process.send({ type: 'entered' });
					await new Promise(() => {});
				});
			`,
        'holder',
      );
      await waitUntil(
        t,
        () => holder.has('entered'),
        () => `The holder must enter its task.\n${holder.stderr}`,
        newProcessTimeout,
      );
      holder.child.kill('SIGKILL');
      await holder.closed;
      const mutex = new Mutex(new SqliteStore(directory.path));

      // Act
      await mutex.acquire('report:daily', async () => {});

      // Assert: the files of the killed holder do not pile up, one set for each crash.
      assert.deepEqual(
        readdirSync(join(directory.path, 'report%3Adaily.lock.holder')),
        [],
      );
    },
  );

  test(
    'a release that cannot remove the holder record rejects with its name, and the key is free',
    { skip: posixOnly, timeout: 10000 },
    async () => {
      // Arrange: the holder folder turns read-only while the task holds the key, so the release cannot remove the record.
      await using directory = await scratchDirectory();
      const mutex = new Mutex(new SqliteStore(directory.path));
      const folder = join(directory.path, 'report%3Adaily.lock.holder');

      // Act
      let release: unknown;
      try {
        release = await mutex
          .acquire('report:daily', () => chmod(folder, 0o555))
          .then(
            () => 'released',
            (error: unknown) => error,
          );
      } finally {
        await chmod(folder, 0o755);
      }
      const held = await mutex.isHeld('report:daily');
      const next = await mutex.acquire('report:daily', async () => 'got it', {
        mode: Modes.skipIfBusy(),
      });

      // Assert
      assert.ok(
        isRecord(release) &&
          typeof release.path === 'string' &&
          release.path.endsWith('caller'),
        `The release must fail and name the record, got ${String(release)}`,
      );
      assert.equal(held, false, 'The key must read as free');
      assert.deepEqual(
        next,
        { acquired: true, value: 'got it' },
        'The next caller in this process must get the key',
      );
    },
  );
});
