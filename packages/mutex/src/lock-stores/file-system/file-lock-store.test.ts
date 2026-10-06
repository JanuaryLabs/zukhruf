import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { LockStore } from '../../mutex/lock-store.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { LockFileStore } from './lock-file-store.ts';
import { TicketQueueFileStore } from './ticket-queue-file-store.ts';

/**
 * Starts another program that opens `path`, as a virus scanner can, letting
 * others do only what `share` allows, and keeps it open until `close` is called.
 */
async function holdOpen(path: string, share: 'None' | 'ReadWrite') {
  const quoted = path.replaceAll("'", "''");
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$file = [System.IO.File]::Open('${quoted}', 'Open', 'Read', '${share}'); [Console]::Out.WriteLine('open'); [void][Console]::In.ReadLine(); $file.Close()`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const { value: first } = await lines[Symbol.asyncIterator]().next();
  assert.equal(first, 'open', `PowerShell must open ${path}`);
  return {
    close: async () => {
      child.stdin.end('\n');
      await exited;
    },
    [Symbol.asyncDispose]: async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

const fileStores: [string, (directory: string) => LockStore][] = [
  ['LockFileStore', (directory) => new LockFileStore(directory)],
  ['TicketQueueFileStore', (directory) => new TicketQueueFileStore(directory)],
];

describe('File lock stores on Windows', () => {
  for (const [name, open] of fileStores) {
    test(
      `${name}: a lock file that another program holds open for a moment fails neither the release nor the next waiter`,
      {
        timeout: 20000,
        skip:
          process.platform === 'win32'
            ? false
            : 'Only Windows refuses a file that another program holds open with no sharing',
      },
      async () => {
        // Arrange: a holder, a waiter, and another program that holds the lock file open with no sharing.
        await using directory = await scratchDirectory();
        const mutex = new Mutex(open(directory.path));
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const holder = mutex.acquire('report-daily', async () => {
          entered.resolve();
          await finish.promise;
        });
        await entered.promise;
        const waiter = mutex.acquire('report-daily', async () => 'next');
        await using scanner = await holdOpen(
          join(directory.path, 'report-daily.lock'),
          'None',
        );

        // Act: the holder releases while the other program holds the file, which then lets it go.
        finish.resolve();
        await delay(100);
        await scanner.close();

        // Assert
        await assert.doesNotReject(
          holder,
          'The release must wait out the other program, not fail',
        );
        assert.equal(await waiter, 'next');
      },
    );

    test(
      `${name}: a presence file that another program keeps open fails the release with its name, and the key is free`,
      {
        timeout: 20000,
        skip:
          process.platform === 'win32'
            ? false
            : 'Only Windows refuses to delete a file that another program holds open',
      },
      async () => {
        // Arrange: a holder, and another program that keeps the holder's
        // presence file open beside SQLite without letting it be deleted.
        await using directory = await scratchDirectory();
        const mutex = new Mutex(open(directory.path));
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const holder = mutex.acquire('report-daily', async () => {
          entered.resolve();
          await finish.promise;
        });
        await entered.promise;
        const [presence] = (await readdir(directory.path)).filter((file) =>
          file.endsWith('.presence'),
        );
        assert.ok(presence, 'The holder must keep a presence file');
        await using scanner = await holdOpen(
          join(directory.path, presence),
          'ReadWrite',
        );

        // Act: the holder releases while the other program keeps the file
        // open for longer than a release waits.
        finish.resolve();

        // Assert: the release names the file it could not delete, and the key is free anyway.
        await assert.rejects(holder, (error: unknown) => {
          assert.ok(error instanceof Error, String(error));
          assert.ok(error.message.includes(presence), error.message);
          return true;
        });
        await scanner.close();
        assert.equal(
          await mutex.acquire('report-daily', async () => 'next'),
          'next',
        );
      },
    );
  }
});
