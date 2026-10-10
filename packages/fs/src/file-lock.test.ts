import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtempDisposable, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { FileLock } from './file-lock.ts';

const fileLockUrl = new URL('./file-lock.ts', import.meta.url);

const importFileLock = `import { FileLock } from ${JSON.stringify(fileLockUrl.href)};`;

/** A holder that keeps its handle referenced, as a holder that uses it does. */
const keepsHandle = (path: string) => `
  ${importFileLock}
  const lock = FileLock.open(${JSON.stringify(path)});
  if (!lock.tryLock()) throw new Error('The holder must get the lock');
  setInterval(() => lock, 1000);
  console.log('holding');
`;

/** A holder that drops its only reference to the handle, and then collects garbage. */
const dropsHandle = (path: string) => `
  ${importFileLock}
  (() => {
    const lock = FileLock.open(${JSON.stringify(path)});
    if (!lock.tryLock()) throw new Error('The holder must get the lock');
  })();
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  setInterval(() => {}, 1000);
  console.log('holding');
`;

/**
 * Starts a process that runs `source` and stays until it is killed. Resolves
 * once the process says that it holds the lock. `gc` is exposed to it.
 */
async function startHolder(source: string) {
  const holder = spawn(
    process.execPath,
    ['--expose-gc', '--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(holder, 'exit');
  const [line] = await Promise.race([
    once(createInterface({ input: holder.stdout }), 'line'),
    exited.then(([code]) => {
      throw new Error(`The holder exited with ${code} before it held the lock`);
    }),
  ]);
  assert.equal(line, 'holding');
  return {
    exited,
    kill: () => holder.kill('SIGKILL'),
  };
}

describe('FileLock', () => {
  test(
    'the kernel frees the lock of a holder that is killed, and the holder leaves no journal file',
    { timeout: 10_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      const holder = await startHolder(keepsHandle(path));
      using lock = FileLock.open(path);
      try {
        assert.equal(
          lock.tryLock(),
          false,
          'A lock that another process holds must refuse',
        );

        // Act
        holder.kill();
        await holder.exited;

        // Assert
        assert.deepEqual(
          await readdir(directory.path),
          ['job.lock'],
          'A killed holder must leave no journal beside the file',
        );
        assert.equal(
          lock.tryLock(),
          true,
          'The lock of a killed holder must be free with no clean-up',
        );
      } finally {
        holder.kill();
      }
    },
  );

  test(
    'a lock and an exclusive transaction of the default journal mode exclude each other',
    { timeout: 2_000 },
    async () => {
      // Arrange: published versions of the packages hold their lock files
      // with a plain exclusive transaction and the default journal.
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      using published = new DatabaseSync(path);
      using lock = FileLock.open(path);
      published.exec('BEGIN EXCLUSIVE');

      // Act
      const lockedWhilePublishedHolds = lock.tryLock();
      published.exec('ROLLBACK');
      const lockedAfterPublishedLetGo = lock.tryLock();

      // Assert
      assert.equal(
        lockedWhilePublishedHolds,
        false,
        'A transaction of a published version must refuse the lock',
      );
      assert.equal(lockedAfterPublishedLetGo, true);
      assert.throws(
        () => published.exec('BEGIN EXCLUSIVE'),
        { errcode: 5 },
        'A held lock must refuse the transaction of a published version',
      );
    },
  );

  test(
    'a lock that another handle in this process holds refuses at once',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      using holder = FileLock.open(path);
      using other = FileLock.open(path);
      holder.tryLock();

      // Act
      const started = performance.now();
      const locked = other.tryLock();
      const elapsed = performance.now() - started;

      // Assert
      assert.equal(locked, false);
      // A wait inside tryLock would block the event loop: callers wait between tries instead.
      assert.ok(
        elapsed < 10,
        `A refusal must not wait, but it took ${elapsed.toFixed(1)} ms`,
      );
    },
  );

  test(
    'a held lock stays held after its handle is garbage collected',
    { timeout: 10_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      using lock = FileLock.open(path);

      // Act
      const holder = await startHolder(dropsHandle(path));
      try {
        // Assert
        assert.equal(
          lock.tryLock(),
          false,
          'Garbage collection must not end a lock that nobody let go',
        );
      } finally {
        holder.kill();
      }
    },
  );

  test(
    'a file with other content makes tryLock throw, not refuse',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      await writeFile(
        path,
        'pid 4242 has held this file since an older release',
      );
      using lock = FileLock.open(path);

      // Act
      const locking = () => lock.tryLock();

      // Assert: a refusal would make a caller wait for a holder that never lets go.
      assert.throws(locking, { errcode: 26 });
    },
  );

  test(
    'check tells a held lock from a free one and from a missing file, and creates no file',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      const absent = join(directory.path, 'absent.lock');
      using lock = FileLock.open(path);
      lock.tryLock();

      // Act
      const whileHeld = FileLock.check(path);
      lock.unlock();
      const afterUnlock = FileLock.check(path);
      const ofAbsent = FileLock.check(absent);

      // Assert
      assert.equal(whileHeld, 'locked');
      assert.equal(afterUnlock, 'unlocked');
      assert.equal(ofAbsent, 'missing');
      assert.deepEqual(
        await readdir(directory.path),
        ['job.lock'],
        'A check must not create the file it checks',
      );
    },
  );

  test(
    'check throws for a directory at the path, as it is no file to lock',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );

      // Act
      const checking = () => FileLock.check(directory.path);

      // Assert
      assert.throws(checking, { code: 'ERR_SQLITE_ERROR' });
    },
  );

  test(
    'check throws for a file that exists but cannot be read, as it is not missing',
    {
      skip:
        process.platform === 'win32' || process.getuid?.() === 0
          ? 'Windows has no file modes, and root reads any file'
          : false,
      timeout: 2_000,
    },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      await writeFile(path, '');
      await chmod(path, 0o000);

      // Act
      const checking = () => FileLock.check(path);

      // Assert
      assert.throws(checking, { errcode: 14 });
    },
  );

  test(
    'unlock and dispose free the lock for the next holder, and a second dispose does nothing',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      using first = FileLock.open(path);
      using second = FileLock.open(path);
      first.tryLock();

      // Act
      first.unlock();
      const secondAfterUnlock = second.tryLock();
      second.unlock();
      const firstAgain = first.tryLock();
      first[Symbol.dispose]();
      const secondAfterDispose = second.tryLock();
      const disposingAgain = () => first[Symbol.dispose]();

      // Assert
      assert.equal(secondAfterUnlock, true, 'An unlock must free the lock');
      assert.equal(firstAgain, true, 'A handle must lock again after unlock');
      assert.equal(
        secondAfterDispose,
        true,
        'A dispose must free the lock that the handle held',
      );
      assert.doesNotThrow(disposingAgain);
    },
  );

  test(
    'tryLock on a handle that holds the lock, and unlock on one that does not, throw',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      using holding = FileLock.open(path);
      using idle = FileLock.open(path);
      holding.tryLock();

      // Act
      const lockingAgain = () => holding.tryLock();
      const unlockingIdle = () => idle.unlock();

      // Assert
      assert.throws(lockingAgain, {
        message: `This handle holds the file lock ${JSON.stringify(path)} already.`,
      });
      assert.throws(unlockingIdle, {
        message: `This handle does not hold the file lock ${JSON.stringify(path)}.`,
      });
    },
  );
});
