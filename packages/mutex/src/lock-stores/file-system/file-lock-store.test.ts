import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
 * Starts another program that opens `path` with no sharing, as a virus scanner
 * can, and keeps it open until `close` is called.
 */
async function holdOpen(path: string) {
  const quoted = path.replaceAll("'", "''");
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$file = [System.IO.File]::Open('${quoted}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('open'); [void][Console]::In.ReadLine(); $file.Close()`,
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
  }
});
