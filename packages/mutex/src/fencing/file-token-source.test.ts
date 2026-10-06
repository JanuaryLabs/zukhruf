import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { describe, mock, test } from 'node:test';

import { scratchDirectory } from '../testing/scratch-directory.ts';
import { FileTokenSource } from './file-token-source.ts';

type DiskEvent =
  | { op: 'write' | 'sync'; path: string }
  | { op: 'rename'; from: string; to: string };

/**
 * Records what this process asks the operating system to write and make
 * durable, by patching node:fs/promises `open` (and each handle's `writeFile`
 * and `sync`) and `rename`. It pins those Node APIs: an equivalent call such
 * as `fs.fsync(fd)` would not be seen. Every call still reaches the real disk.
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

describe('FileTokenSource durability', () => {
  test('a minted token is written and on disk before it replaces the previous one', async () => {
    // Arrange
    await using directory = await scratchDirectory();
    const tokens = new FileTokenSource(directory.path);
    using disk = recordDiskWrites();

    // Act
    const token = await tokens.next('product:42');

    // Assert: content first, then its sync, then the one-step replacement, which holds the minted token.
    const replacement = disk.replacementIn(directory.path);
    const before = disk.events.slice(0, replacement.index);
    const written = before.findIndex(
      (event) => event.op === 'write' && event.path === replacement.from,
    );
    const synced = before.findIndex(
      (event) => event.op === 'sync' && event.path === replacement.from,
    );
    assert.ok(written >= 0, 'The new counter must be written');
    assert.ok(
      synced > written,
      'The new counter must reach the disk after it is written and before it replaces the old one',
    );
    assert.equal(
      await fsPromises.readFile(replacement.to, 'utf8'),
      token.toString(),
    );
  });

  test(
    'the replacement is on disk before next() returns, so a power loss cannot repeat a token',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows never syncs a directory'
          : false,
    },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const tokens = new FileTokenSource(directory.path);
      using disk = recordDiskWrites();

      // Act
      await tokens.next('product:42');

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

  test('a token that cannot reach the disk leaves the directory as it was and does not use up a token', async () => {
    // Arrange: one token is minted, then the disk refuses to sync any new file in the directory.
    await using directory = await scratchDirectory();
    const tokens = new FileTokenSource(directory.path);
    const first = await tokens.next('product:42');
    const filesBefore = await fsPromises.readdir(directory.path);

    // Act
    {
      using _refused = refuseSync(
        (path) => dirname(path) === directory.path,
        'EIO',
      );
      await assert.rejects(tokens.next('product:42'), { code: 'EIO' });
    }

    // Assert
    assert.deepEqual(
      await fsPromises.readdir(directory.path),
      filesBefore,
      'A failed mint must not leave its draft in the directory',
    );
    const next = await tokens.next('product:42');
    assert.equal(
      next.toString(),
      (BigInt(first.toString()) + 1n).toString(),
      'A failed mint must not use up a token',
    );
  });

  for (const [code, outcome] of [
    ['EINVAL', 'mints'],
    ['ENOTSUP', 'mints'],
    ['EIO', 'fails'],
  ] as const) {
    test(
      `a directory sync that fails with ${code} ${outcome === 'mints' ? 'still mints the token' : 'fails the mint'}`,
      {
        skip:
          process.platform === 'win32'
            ? 'Windows never syncs a directory'
            : false,
      },
      async () => {
        // Arrange: a file system whose directories answer fsync with `code`.
        await using directory = await scratchDirectory();
        const tokens = new FileTokenSource(directory.path);
        using _refused = refuseSync((path) => path === directory.path, code);

        // Act
        const minting = tokens.next('product:42');

        // Assert: a file system that cannot sync directories at all still works; a disk error does not pass silently.
        if (outcome === 'mints') {
          const first = await minting;
          const second = await tokens.next('product:42');
          assert.ok(
            second.isNewerThan(first),
            'Tokens must still be minted, each newer than the last',
          );
        } else {
          await assert.rejects(minting, { code });
        }
      },
    );
  }
});
