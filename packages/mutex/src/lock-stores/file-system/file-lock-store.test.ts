import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';

import { CounterTokenSource, type TokenSource } from '@zukhruf/fencing';
import { isErrno } from '@zukhruf/fs';

import type { LockStore } from '../../mutex/lock-store.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { SqliteStore } from '../sqlite/sqlite-store.ts';
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

/**
 * Each file lock store with the longest key it held before keys of any length
 * were possible, and the files it makes for a key while it holds the key.
 */
const namedStores = [
  {
    name: 'LockFileStore',
    open: (directory: string) => new LockFileStore(directory),
    longest: 204,
    fence: true,
    presence: true,
  },
  {
    name: 'TicketQueueFileStore',
    open: (directory: string) => new TicketQueueFileStore(directory),
    longest: 204,
    fence: true,
    presence: true,
  },
  {
    name: 'SqliteStore',
    open: (directory: string) => new SqliteStore(directory),
    longest: 208,
    fence: true,
    presence: false,
  },
  {
    name: 'SqliteStore with tokens in memory',
    open: (directory: string) =>
      new SqliteStore(directory, { tokens: new CounterTokenSource() }),
    longest: 242,
    fence: false,
    presence: false,
  },
];

describe('Lock file names', () => {
  for (const store of namedStores) {
    for (const [key, name] of [
      ['orders/حساب.v2', 'orders%2F%D8%AD%D8%B3%D8%A7%D8%A8%2Ev2'],
      ['k'.repeat(store.longest), 'k'.repeat(store.longest)],
    ] as const) {
      test(`${store.name} keeps the file name that earlier versions gave a key of ${key.length} characters`, async () => {
        // Arrange: processes of an earlier version may use the same directory.
        await using directory = await scratchDirectory();
        const mutex = new Mutex(store.open(directory.path));

        // Act: list the directory while the key is held.
        const files = await mutex.acquire(key, () => readdir(directory.path));

        // Assert: the files have the names that the earlier version uses, so both versions share the lock.
        assert.ok(
          files.includes(`${name}.lock`),
          `The lock file must be ${name}.lock, got ${files.join(', ')}`,
        );
        if (store.fence) {
          assert.ok(
            files.includes(`${name}.fence`),
            `The token file must be ${name}.fence, got ${files.join(', ')}`,
          );
        }
        if (store.presence) {
          assert.ok(
            files.some(
              (file) =>
                file.startsWith(`${name}.lock.`) && file.endsWith('.presence'),
            ),
            `The presence file must be named after ${name}.lock, got ${files.join(', ')}`,
          );
        }
      });
    }

    test(`${store.name} holds a key one character longer than the longest key that earlier versions held`, async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const mutex = new Mutex(store.open(directory.path));

      // Act
      const result = await mutex.acquire(
        'k'.repeat(store.longest + 1),
        async () => 'held',
      );

      // Assert
      assert.equal(result, 'held');
    });
  }
});

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

describe('LockFileStore damaged lock file', () => {
  // Text that is not JSON, or JSON that names no caller.
  for (const damaged of ['garbage', '{"pid":1}']) {
    test(`a lock file that holds ${damaged} makes every call reject with a SyntaxError and stays as it is`, async () => {
      // Arrange: a power loss in the middle of a write can leave such a file; no operation writes one.
      await using directory = await scratchDirectory();
      const store = new LockFileStore(directory.path, { pollInterval: 10 });
      const lockFile = join(directory.path, 'report-daily.lock');
      await writeFile(lockFile, damaged);

      // Act
      const calls = await Promise.allSettled([
        store.acquire('report-daily', { signal: AbortSignal.timeout(2000) }),
        store.tryAcquire('report-daily'),
        store.isHeld('report-daily'),
      ]);

      // Assert: nobody can tell who holds the key, so it stays blocked, loudly, and the file is kept for a person to read.
      assert.deepEqual(
        calls.map((call) =>
          call.status === 'rejected' ? call.reason?.constructor : call.status,
        ),
        [SyntaxError, SyntaxError, SyntaxError],
        'acquire, tryAcquire and isHeld must each reject with a SyntaxError',
      );
      assert.equal(await readFile(lockFile, 'utf8'), damaged);
    });
  }
});

/** Fails the first token it is asked for, and counts after that. */
function failingOnce(failure: Error): TokenSource {
  const counter = new CounterTokenSource();
  let failed = false;
  return {
    next(key) {
      if (failed) return counter.next(key);
      failed = true;
      return Promise.reject(failure);
    },
  };
}

describe('File lock stores whose token source fails', () => {
  for (const [name, open] of [
    [
      'LockFileStore',
      (directory: string, tokens: TokenSource) =>
        new LockFileStore(directory, { pollInterval: 10, tokens }),
    ],
    [
      'TicketQueueFileStore',
      (directory: string, tokens: TokenSource) =>
        new TicketQueueFileStore(directory, { pollInterval: 10, tokens }),
    ],
    [
      'SqliteStore',
      (directory: string, tokens: TokenSource) =>
        new SqliteStore(directory, { pollInterval: 10, tokens }),
    ],
  ] as const) {
    test(`${name}: an acquire whose token cannot be minted rejects with that error and leaves the key free`, async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const failure = new Error('The token file could not be written.');
      const store = open(directory.path, failingOnce(failure));

      // Act
      const acquiring = store.acquire('report-daily');

      // Assert: the caller learns the real cause, and the lock taken for it is given back.
      await assert.rejects(acquiring, (error) => error === failure);
      assert.equal(await store.isHeld('report-daily'), false);
      const next = await store.tryAcquire('report-daily');
      assert.ok(next, 'The next caller must get the key at once');
      await next[Symbol.asyncDispose]();
    });
  }
});

test(
  'LockFileStore: an acquire whose token cannot be minted and whose lock cannot be given back rejects with both errors',
  {
    skip:
      process.platform === 'win32'
        ? 'Windows has no read-only directories'
        : process.getuid?.() === 0
          ? 'root writes into a read-only directory'
          : false,
  },
  async () => {
    // Arrange: the token source runs while the lock file exists. It makes the
    // directory read-only, so the release that gives the lock back cannot
    // delete that file, and then it fails.
    await using directory = await scratchDirectory();
    const failure = new Error('The token file could not be written.');
    const tokens: TokenSource = {
      async next() {
        await chmod(directory.path, 0o555);
        throw failure;
      },
    };
    const store = new LockFileStore(directory.path, { tokens });

    // Act
    let rejection: unknown;
    try {
      rejection = await store.acquire('report-daily').then(
        () => 'acquired',
        (error: unknown) => error,
      );
    } finally {
      await chmod(directory.path, 0o755);
    }

    // Assert: the caller learns both causes, the failed release and the failed mint under it.
    assert.ok(
      rejection instanceof SuppressedError,
      `The acquire must reject with a SuppressedError, got ${String(rejection)}`,
    );
    assert.ok(
      isErrno(rejection.error, 'EACCES'),
      `The release must fail for the read-only directory, got ${String(rejection.error)}`,
    );
    assert.equal(rejection.suppressed, failure);
  },
);
