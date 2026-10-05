import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, mock, test } from 'node:test';

import type { Lease } from '../../mutex/lease.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { TicketQueueFileStore } from './ticket-queue-file-store.ts';

const fsPromises = createRequire(import.meta.url)(
  'node:fs/promises',
) as typeof import('node:fs/promises');

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
      const deadline = Promise.withResolvers<'still waiting'>();
      const timer = setTimeout(() => deadline.resolve('still waiting'), 2000);
      let waiter: Promise<Lease> | undefined;

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
        const outcome = await Promise.race([waiter, deadline.promise]);
        assert.notEqual(
          outcome,
          'still waiting',
          'A waiter whose ticket was lost must append it again and get the key',
        );
      } finally {
        clearTimeout(timer);
        proceed.resolve();
        mock.restoreAll();
        syncBuiltinESMExports();
        const lease = await Promise.race([waiter, deadline.promise]);
        if (typeof lease === 'object') await lease[Symbol.asyncDispose]();
      }
    },
  );
});
