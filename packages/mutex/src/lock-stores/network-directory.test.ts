import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { test } from '@zukhruf/testing/node';

import { mountAs, onLinux } from '../testing/network-mount.ts';
import { outcome } from '../testing/outcome.ts';
import { LockFileStore, NetworkDirectoryError } from './file-system/index.ts';
import { type SocketRole, SocketStore } from './socket/index.ts';

describe('A lock directory on a network file system', () => {
  test(
    'a directory that does not exist yet is judged by its nearest existing parent',
    onLinux,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const notYet = join(directory.path, 'not', 'yet');
      using _mount = mountAs(t, directory.path, 0x6969n);
      const store = new LockFileStore(notYet, { clock: globalThis });

      // Act
      const result = await outcome(store.acquire('product:42'));

      // Assert: the parent's file system decides, and the directory is not created there.
      assert.ok(
        result instanceof NetworkDirectoryError,
        `got ${String(result)}`,
      );
      assert.deepEqual(await fsPromises.readdir(directory.path), []);
    },
  );

  test(
    'a socket store that fails over never judges its directory again, so its holders keep their keys',
    onLinux,
    async (t) => {
      // Arrange: a leader and a follower that holds a key, both past the check.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const options = { pollInterval: 10, graceWindow: 50 };
      const leader = new SocketStore(directory.path, {
        ...options,
        clock: globalThis,
      });
      await using follower = new SocketStore(directory.path, {
        ...options,
        clock: globalThis,
      });
      try {
        await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
        const held = await follower.acquire('product:42');
        const roles: SocketRole[] = [];
        follower.on('role', (role) => roles.push(role));

        // Act: the leader stops while the directory would now look like a network mount.
        using _mount = mountAs(t, directory.path, 0x6969n);
        await leader[Symbol.asyncDispose]();
        await t.waitFor(
          () =>
            assert.ok(
              roles.includes('leader'),
              'The follower must take over as leader',
            ),
          { interval: 5, timeout: 2000 },
        );

        // Assert: the mount is live, yet the takeover did not judge the directory again, so the holder never lost its key.
        await assert.rejects(
          new LockFileStore(join(directory.path, 'sibling'), {
            clock: globalThis,
          }).acquire('product:42'),
          NetworkDirectoryError,
        );
        await held[Symbol.asyncDispose]();
      } finally {
        await leader[Symbol.asyncDispose]();
      }
    },
  );

  test(
    'a socket store refuses a network directory even when a leader already serves it',
    onLinux,
    async (t) => {
      // Arrange: a leader serves the directory; a second store reaches it through a
      // symlink that looks like a network mount, so it would follow without campaigning.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const options = { pollInterval: 10, graceWindow: 50 };
      await using leader = new SocketStore(directory.path, {
        ...options,
        clock: globalThis,
      });
      await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
      const viaShare = join(directory.path, 'share');
      await symlink(directory.path, viaShare);
      using _mount = mountAs(t, viaShare, 0x6969n);
      await using follower = new SocketStore(viaShare, {
        ...options,
        clock: globalThis,
      });

      // Act
      const result = await outcome(follower.acquire('product:42'));

      // Assert
      assert.ok(
        result instanceof NetworkDirectoryError,
        `A store must refuse a network directory before it follows anyone, got ${String(result)}`,
      );
    },
  );
});
