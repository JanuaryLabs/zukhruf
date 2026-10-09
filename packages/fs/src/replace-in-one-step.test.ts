import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, mock, test } from 'node:test';

import { atomicWrite } from './atomic-write.ts';
import { durableWrite } from './durable-write.ts';

type DiskEvent =
  | { op: 'write' | 'sync'; path: string }
  | { op: 'rename'; from: string; to: string };

/**
 * Records what this process asks the operating system to write and make
 * durable, by patching node:fs/promises `open` (and each handle's `writeFile`
 * and `sync`) and `rename`. It pins those Node APIs: an equivalent call such
 * as `fs.fsync(fd)` would not be seen. Every call still reaches the real disk.
 * A copy of the recorder in @zukhruf/mutex's durability tests: test helpers
 * stay in their test files (backlog #2509).
 */
function recordDiskWrites() {
  const events: DiskEvent[] = [];
  const open = fsPromises.open;
  const rename = fsPromises.rename;
  mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await open(...args);
      const path = String(args[0]);
      const writeFile = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.writeFile = async (...data: Parameters<typeof writeFile>) => {
        events.push({ op: 'write', path });
        return writeFile(...data);
      };
      handle.sync = async () => {
        events.push({ op: 'sync', path });
        return sync();
      };
      return handle;
    },
  );
  mock.method(fsPromises, 'rename', async (from: string, to: string) => {
    events.push({ op: 'rename', from, to });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  return {
    events,
    /** The rename that put a new file into `directory`, and where it sits among the events. */
    replacementIn(directory: string) {
      const index = events.findIndex(
        (event) => event.op === 'rename' && dirname(event.to) === directory,
      );
      const event = events[index];
      assert.ok(
        event?.op === 'rename',
        'The file must be replaced in one step',
      );
      return { index, from: event.from, to: event.to };
    },
    [Symbol.dispose]() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

/** Makes `sync` fail with `code`, as a file system would, on every handle opened at a path that `refused` matches. */
function refuseSync(refused: (path: string) => boolean, code: string) {
  const open = fsPromises.open;
  mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await open(...args);
      if (refused(String(args[0]))) {
        handle.sync = async () => {
          throw Object.assign(new Error(`${code}: fsync failed`), {
            code,
            syscall: 'fsync',
          });
        };
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  return {
    [Symbol.dispose]() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

const neverOnWindows = {
  skip:
    process.platform === 'win32' ? 'Windows never syncs a directory' : false,
};

describe('A replacement in one step', () => {
  test(
    'an atomic write that cannot replace the path leaves no draft and leaves the path as it was',
    { timeout: 2_000 },
    async () => {
      // Arrange: a directory with content sits at the path, so the rename fails after the draft exists.
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'queue');
      await mkdir(path);
      await writeFile(join(path, 'kept'), 'old');

      // Act
      const writing = atomicWrite(path, 'first\n');

      // Assert
      await assert.rejects(writing, { code: 'EISDIR' });
      assert.deepEqual(
        await readdir(directory.path),
        ['queue'],
        'A failed write must not leave its draft',
      );
      assert.equal(await readFile(join(path, 'kept'), 'utf8'), 'old');
    },
  );

  test(
    'a durable write that cannot replace the path leaves no draft and leaves the path as it was',
    { timeout: 2_000 },
    async () => {
      // Arrange: a directory with content sits at the path, so the rename fails after the draft exists.
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'counter');
      await mkdir(path);
      await writeFile(join(path, 'kept'), 'old');

      // Act
      const writing = durableWrite(path, '42');

      // Assert
      await assert.rejects(writing, { code: 'EISDIR' });
      assert.deepEqual(
        await readdir(directory.path),
        ['counter'],
        'A failed write must not leave its draft',
      );
      assert.equal(await readFile(join(path, 'kept'), 'utf8'), 'old');
    },
  );

  test(
    'a durable write that cannot sync its draft rejects, leaves no draft, and keeps the old content',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'counter');
      await writeFile(path, '41');
      using _refused = refuseSync((opened) => opened !== directory.path, 'EIO');

      // Act
      const writing = durableWrite(path, '42');

      // Assert
      await assert.rejects(writing, { code: 'EIO' });
      assert.deepEqual(await readdir(directory.path), ['counter']);
      assert.equal(await readFile(path, 'utf8'), '41');
    },
  );

  test(
    'an atomic write puts the new content in place with one rename of a draft beside the path',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'queue');
      await writeFile(path, 'first\n');
      using disk = recordDiskWrites();

      // Act
      await atomicWrite(path, 'first\nsecond\n');

      // Assert
      const replacement = disk.replacementIn(directory.path);
      assert.equal(replacement.to, path);
      assert.equal(dirname(replacement.from), directory.path);
      assert.equal(await readFile(path, 'utf8'), 'first\nsecond\n');
      assert.deepEqual(await readdir(directory.path), ['queue']);
    },
  );

  test(
    'a durable write writes and syncs its draft before the rename that puts it in place',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'counter');
      await writeFile(path, '41');
      using disk = recordDiskWrites();

      // Act
      await durableWrite(path, '42');

      // Assert: content first, then its sync, then the one-step replacement.
      const replacement = disk.replacementIn(directory.path);
      const before = disk.events.slice(0, replacement.index);
      const written = before.findIndex(
        (event) => event.op === 'write' && event.path === replacement.from,
      );
      const synced = before.findIndex(
        (event) => event.op === 'sync' && event.path === replacement.from,
      );
      assert.equal(replacement.to, path);
      assert.ok(written >= 0, 'The draft must be written');
      assert.ok(
        synced > written,
        'The draft must reach the disk after it is written and before it replaces the old file',
      );
      assert.equal(await readFile(path, 'utf8'), '42');
    },
  );

  test(
    'a durable write syncs the directory after the rename, so a power loss cannot undo it',
    { ...neverOnWindows, timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'counter');
      using disk = recordDiskWrites();

      // Act
      await durableWrite(path, '42');

      // Assert
      const replacement = disk.replacementIn(directory.path);
      assert.ok(
        disk.events
          .slice(replacement.index + 1)
          .some(
            (event) => event.op === 'sync' && event.path === directory.path,
          ),
        'The directory that holds the replacement must reach the disk after the rename',
      );
    },
  );

  for (const [code, outcome] of [
    ['EINVAL', 'writes'],
    ['ENOTSUP', 'writes'],
    ['EIO', 'fails'],
  ] as const) {
    test(
      `a directory sync that fails with ${code} ${outcome === 'writes' ? 'still completes the durable write' : 'fails the durable write'}`,
      { ...neverOnWindows, timeout: 2_000 },
      async () => {
        // Arrange: a file system whose directories answer fsync with `code`.
        await using directory = await mkdtempDisposable(
          join(tmpdir(), 'zukhruf-fs-'),
        );
        const path = join(directory.path, 'counter');
        using _refused = refuseSync(
          (opened) => opened === directory.path,
          code,
        );

        // Act
        const writing = durableWrite(path, '42');

        // Assert: a file system that cannot sync directories still works; a disk error does not pass silently.
        if (outcome === 'writes') {
          await writing;
          assert.equal(await readFile(path, 'utf8'), '42');
        } else {
          await assert.rejects(writing, { code });
        }
      },
    );
  }
});
