import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, { readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { LockHandle } from '../../mutex/lease.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { newProcessTimeout, waitUntil } from '../../testing/wait-until.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { TicketQueueFileStore } from './ticket-queue-file-store.ts';

const storeUrl = new URL('./ticket-queue-file-store.ts', import.meta.url);

const ticketsIn = (queue: string) =>
  readFileSync(queue, 'utf8').split('\n').filter(Boolean).length;

describe('TicketQueueFileStore', () => {
  test(
    'a waiter whose ticket a release rewrite lost appends it again and gets the key',
    { timeout: 5000 },
    async (t) => {
      // Arrange: a holder, and a file system that pauses the rename that replaces the queue.
      await using directory = await scratchDirectory();
      const store = new TicketQueueFileStore(directory.path, {
        pollInterval: 10,
      });
      const queue = join(directory.path, 'product%3A42.lock');
      const holder = await store.acquire('product:42');
      const renaming = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const rename = fsPromises.rename;
      mock.method(fsPromises, 'rename', async (from: string, to: string) => {
        if (to === queue) {
          renaming.resolve();
          await proceed.promise;
        }
        return rename(from, to);
      });
      syncBuiltinESMExports();
      const deadline = delay(2000, 'still waiting' as const, { ref: false });
      let waiter: Promise<LockHandle> | undefined;

      try {
        // Act: the holder has read the queue and paused before it replaces the file.
        const released = holder[Symbol.asyncDispose]();
        await renaming.promise;
        // A waiter appends its ticket to the file that the rename is about to replace.
        waiter = store.acquire('product:42');
        await waitUntil(
          t,
          () => ticketsIn(queue) === 2,
          'The waiter must append its ticket',
        );
        // The rename replaces the queue with a copy that has no ticket for the waiter.
        proceed.resolve();
        await released;

        // Assert: the waiter notices its lost ticket, appends it again, and gets the key.
        const outcome = await Promise.race([waiter, deadline]);
        assert.notEqual(
          outcome,
          'still waiting',
          'A waiter whose ticket was lost must append it again and get the key',
        );
      } finally {
        proceed.resolve();
        mock.restoreAll();
        syncBuiltinESMExports();
        const lease = await Promise.race([waiter, deadline]);
        if (typeof lease === 'object') await lease[Symbol.asyncDispose]();
      }
    },
  );
});

describe('TicketQueueFileStore holder check', () => {
  test(
    'a queue whose first caller was killed reads as not held, though a waiter still waits behind it',
    { timeout: 30000 },
    async (t) => {
      // Arrange: a holder process, and a waiter process in line that checks the queue only once a minute.
      await using directory = await scratchDirectory();
      const queue = join(directory.path, 'report%3Adaily.lock');
      const caller = (pollInterval: number) => `
				import { TicketQueueFileStore } from ${JSON.stringify(storeUrl.href)};
				const store = new TicketQueueFileStore(${JSON.stringify(directory.path)}, { pollInterval: ${pollInterval} });
				setInterval(() => {}, 1000);
				await store.acquire('report:daily');
				process.send({ type: 'entered' });
			`;
      await using holder = startWorker(caller(10), 'holder');
      await waitUntil(
        t,
        () => holder.has('entered'),
        () => `The holder must enter.\n${holder.stderr}`,
        newProcessTimeout,
      );
      await using waiter = startWorker(caller(60_000), 'waiter');
      // No operation says that a waiter is in line, so the wait reads the queue.
      await waitUntil(
        t,
        () => ticketsIn(queue) === 2,
        () => `The waiter must join the line.\n${waiter.stderr}`,
        newProcessTimeout,
      );
      const mutex = new Mutex(new TicketQueueFileStore(directory.path));

      // Act
      holder.child.kill('SIGKILL');
      await holder.closed;
      const held = await mutex.isHeld('report:daily');

      // Assert
      assert.equal(
        held,
        false,
        'A waiter behind a gone caller holds nothing yet',
      );
      assert.equal(
        waiter.exit,
        null,
        'The waiter must still be alive and in line',
      );
    },
  );
});

/** The errors that `error` carries: a waiter that leaves reads the queue too, so its clean-up can fail as well. */
const errorsIn = (error: unknown): unknown[] =>
  error instanceof SuppressedError
    ? [...errorsIn(error.error), ...errorsIn(error.suppressed)]
    : [error];

describe('TicketQueueFileStore damaged queue', () => {
  // Text that is not JSON, or JSON that names no caller.
  for (const damaged of ['garbage', '{"pid":1}']) {
    test(`a first ticket line that holds ${damaged} makes every call reject with a SyntaxError and stays first`, async () => {
      // Arrange: a power loss can leave a complete line whose bytes never reached the disk; no operation writes one.
      // (A line without its newline is an append still in progress, which the store skips.)
      await using directory = await scratchDirectory();
      const store = new TicketQueueFileStore(directory.path, {
        pollInterval: 10,
      });
      const queue = join(directory.path, 'report-daily.lock');
      await writeFile(queue, `${damaged}\n`);

      // Act
      const calls = await Promise.allSettled([
        store.acquire('report-daily', { signal: AbortSignal.timeout(2000) }),
        store.tryAcquire('report-daily'),
        store.isHeld('report-daily'),
      ]);

      // Assert: nobody can tell who is first, so the key stays blocked, loudly, and the line is kept for a person to read.
      assert.deepEqual(
        calls.map((call) =>
          call.status === 'rejected'
            ? [...new Set(errorsIn(call.reason).map((e) => e?.constructor))]
            : call.status,
        ),
        [[SyntaxError], [SyntaxError], [SyntaxError]],
        'acquire, tryAcquire and isHeld must each reject because of the damaged line',
      );
      assert.ok(
        (await readFile(queue, 'utf8')).startsWith(`${damaged}\n`),
        'The damaged ticket must stay first in the queue',
      );
    });
  }
});
