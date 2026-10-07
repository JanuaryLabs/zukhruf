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
 * A PowerShell loads each call the first time it makes it, and the first
 * PowerShell of a run loads slowly, so the program makes each call of the hold
 * once before it opens the file. The first PowerShell of a run can also take
 * most of a test's time limit to start on a busy Windows runner, so these
 * tests keep the suite's limit.
 */
async function holdOpen(
  path: string,
  share: 'None' | 'ReadWrite',
  moment?: number,
) {
  const quoted = path.replaceAll("'", "''");
  const now = '[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()';
  const keep =
    moment === undefined
      ? '[void][Console]::In.ReadLine()'
      : `[System.Threading.Thread]::Sleep(${moment})`;
  const script = [
    '$warm = [System.IO.Path]::GetTempFileName()',
    `[System.IO.File]::Open($warm, 'Open', 'Read', '${share}').Close()`,
    '[System.IO.File]::Delete($warm)',
    '[System.Threading.Thread]::Sleep(0)',
    `[Console]::Out.WriteLine('ready ' + ${now})`,
    '[void][Console]::In.ReadLine()',
    `$file = [System.IO.File]::Open('${quoted}', 'Open', 'Read', '${share}')`,
    `[Console]::Out.WriteLine('open ' + ${now})`,
    keep,
    '$file.Close()',
    `[Console]::Out.WriteLine('closed ' + ${now})`,
  ].join('; ');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const reported = async (event: 'ready' | 'open' | 'closed') => {
    const { value } = await lines.next();
    const [said, time] = String(value).split(' ');
    assert.equal(said, event, `PowerShell must report ${event} for ${path}`);
    return Number(time);
  };
  await reported('ready');
  child.stdin.write('\n');
  const openedAt = await reported('open');
  // A program timed by itself reads nothing more, and an input at its end lets it exit.
  if (moment !== undefined) child.stdin.end();
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
        // Settled from the start, so a failure is reported with the times below.
        const outcomes = Promise.allSettled([holder, waiter]);
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
        const times = `The other program held the file for ${closedAt - scanner.openedAt} ms, and the holder released ${releasedAt - scanner.openedAt} ms after the open`;
        assert.ok(
          releasedAt < closedAt,
          `${times}, so the release met no refusal`,
        );
        assert.deepEqual(
          await outcomes,
          [
            { status: 'fulfilled', value: undefined },
            { status: 'fulfilled', value: 'next' },
          ],
          `${times}. The release and the waiter must wait out the other program, not fail`,
        );
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
