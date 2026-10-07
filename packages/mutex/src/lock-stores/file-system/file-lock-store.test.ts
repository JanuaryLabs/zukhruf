import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';

import type { LockStore } from '../../mutex/lock-store.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { LockFileStore } from './lock-file-store.ts';
import { TicketQueueFileStore } from './ticket-queue-file-store.ts';

/**
 * Starts another program that opens `path`, as a virus scanner can, letting
 * others do only what `share` allows. It keeps the file open until `close` is
 * called, or, with `moment`, for that many milliseconds after it opened the
 * file: a moment timed by this process would also count the time that each
 * process takes to answer the other, which a busy runner stretches past the
 * second that a refusal may last. The program tells the clock time at which it
 * opened the file and at which it let go.
 * The first PowerShell of a run can take most of a test's time limit to start
 * on a busy Windows runner, so these tests keep the suite's limit.
 */
async function holdOpen(
  path: string,
  share: 'None' | 'ReadWrite',
  moment?: number,
) {
  const quoted = path.replaceAll("'", "''");
  const keep =
    moment === undefined
      ? '[void][Console]::In.ReadLine()'
      : `Start-Sleep -Milliseconds ${moment}`;
  const now = '[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()';
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$file = [System.IO.File]::Open('${quoted}', 'Open', 'Read', '${share}'); [Console]::Out.WriteLine('open ' + ${now}); ${keep}; $file.Close(); [Console]::Out.WriteLine('closed ' + ${now})`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  // A program timed by itself reads nothing, and an input at its end lets it exit.
  if (moment !== undefined) child.stdin.end();
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const reported = async (event: 'open' | 'closed') => {
    const { value } = await lines.next();
    const [said, time] = String(value).split(' ');
    assert.equal(said, event, `PowerShell must report ${event} for ${path}`);
    return Number(time);
  };
  const openedAt = await reported('open');
  return {
    openedAt,
    /** Lets go of the file, or, after a moment, waits until the program let go; resolves the time at which it did. */
    close: async () => {
      if (child.stdin.writable) child.stdin.end('\n');
      const closedAt = await reported('closed');
      await exited;
      return closedAt;
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
        // Half of the second that `patiently` waits out, so the holder releases inside the moment.
        await using scanner = await holdOpen(
          join(directory.path, 'report-daily.lock'),
          'None',
          500,
        );

        // Act: the holder releases while the other program holds the file, which then lets it go.
        const releasedAt = Date.now();
        finish.resolve();
        const closedAt = await scanner.close();

        // Assert: the release met the refusal, and neither the release nor the waiter failed.
        assert.ok(
          releasedAt < closedAt,
          `The holder released ${releasedAt - scanner.openedAt} ms after the other program opened the file, but it let go after ${closedAt - scanner.openedAt} ms, so the release met no refusal`,
        );
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
