import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, { mkdtempDisposable, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, mock, test } from 'node:test';

import { assertLocalDirectory } from './local-directory.ts';
import { NetworkDirectoryError } from './network-directory-error.ts';

/** The `f_type` that Linux's statfs reports for each network file system, from the kernel's and Lustre's headers. */
const networkFileSystems = [
  ['NFS', 0x6969n],
  ['SMB', 0x517bn],
  ['CIFS', 0xff534d42n],
  ['SMB2', 0xfe534d42n],
  ['Ceph', 0x00c36400n],
  ['AFS', 0x5346414fn],
  ['kAFS', 0x6b414653n],
  ['Coda', 0x73757245n],
  ['NCP', 0x564cn],
  ['OCFS2', 0x7461636fn],
  ['GFS2', 0x01161970n],
  ['Lustre', 0x0bd00bd0n],
  ['9p', 0x01021997n],
] as const;

/** Whether `path` is `directory` itself or lies inside it. */
const within = (directory: string, path: string) =>
  path === directory || path.startsWith(directory + sep);

/**
 * Makes statfs report `type` for `directory` and everything inside it, as a
 * mount of that file system would. Every other path gets the real answer.
 * A copy of the helper in @zukhruf/mutex's network directory tests: test
 * helpers stay in their test files (backlog #2509).
 */
function mountAs(directory: string, type: bigint) {
  const statfs = fsPromises.statfs;
  mock.method(
    fsPromises,
    'statfs',
    async (...args: Parameters<typeof fsPromises.statfs>) => {
      const stats = await statfs(...args);
      return within(directory, String(args[0]))
        ? Object.assign(stats, { type })
        : stats;
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

/** Makes every statfs of `directory` fail with `code`, as a broken mount would. */
function failStatfs(directory: string, code: string) {
  const statfs = fsPromises.statfs;
  mock.method(
    fsPromises,
    'statfs',
    async (...args: Parameters<typeof fsPromises.statfs>) => {
      if (within(directory, String(args[0]))) {
        throw Object.assign(new Error(`${code}: statfs failed`), {
          code,
          syscall: 'statfs',
        });
      }
      return statfs(...args);
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

const onLinux = {
  skip:
    process.platform === 'linux'
      ? false
      : 'Only Linux statfs reports a stable file system type',
};

describe('A network directory', () => {
  for (const [fileSystem, type] of networkFileSystems) {
    test(
      `a directory on ${fileSystem} is refused with the directory and its file system`,
      { ...onLinux, timeout: 2_000 },
      async () => {
        // Arrange
        await using directory = await mkdtempDisposable(
          join(tmpdir(), 'zukhruf-fs-'),
        );
        using _mount = mountAs(directory.path, type);

        // Act
        const checking = assertLocalDirectory(directory.path);

        // Assert
        await assert.rejects(checking, (error) => {
          assert.ok(error instanceof NetworkDirectoryError);
          assert.equal(error.directory, directory.path);
          assert.equal(error.fileSystem, fileSystem);
          return true;
        });
      },
    );
  }

  for (const [fileSystem, type] of [
    ['CIFS', 0xff534d42n],
    ['SMB2', 0xfe534d42n],
  ] as const) {
    test(
      `a ${fileSystem} type that statfs reports sign-extended is still refused`,
      { ...onLinux, timeout: 2_000 },
      async () => {
        // Arrange: f_type is a signed long, so libuv hands over a magic with its high bit set as 64 sign-extended bits.
        await using directory = await mkdtempDisposable(
          join(tmpdir(), 'zukhruf-fs-'),
        );
        using _mount = mountAs(directory.path, 0xffff_ffff_0000_0000n | type);

        // Act
        const checking = assertLocalDirectory(directory.path);

        // Assert
        await assert.rejects(checking, { fileSystem });
      },
    );
  }

  for (const [name, type] of [
    ['ext4', 0xef53n],
    ['a FUSE mount', 0x65735546n],
  ] as const) {
    test(
      `a directory on ${name} counts as local`,
      { ...onLinux, timeout: 2_000 },
      async () => {
        // Arrange
        await using directory = await mkdtempDisposable(
          join(tmpdir(), 'zukhruf-fs-'),
        );
        using _mount = mountAs(directory.path, type);

        // Act
        const checking = assertLocalDirectory(directory.path);

        // Assert
        await assert.doesNotReject(checking);
      },
    );
  }

  test(
    'a directory that does not exist yet is judged by its nearest parent, and is not created',
    { ...onLinux, timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const notYet = join(directory.path, 'not', 'yet');
      using _mount = mountAs(directory.path, 0x6969n);

      // Act
      const checking = assertLocalDirectory(notYet);

      // Assert
      await assert.rejects(checking, NetworkDirectoryError);
      assert.deepEqual(await readdir(directory.path), []);
    },
  );

  test(
    'a statfs that fails tells nothing, so the directory is not refused',
    { ...onLinux, timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      using _failing = failStatfs(directory.path, 'EIO');

      // Act
      const checking = assertLocalDirectory(directory.path);

      // Assert
      await assert.doesNotReject(checking);
    },
  );

  test(
    'a statfs that failed once is not remembered, so a later check can still refuse the directory',
    { ...onLinux, timeout: 2_000 },
    async () => {
      // Arrange: the first check cannot read the file system, then the mount answers as NFS.
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      {
        using _failing = failStatfs(directory.path, 'EIO');
        await assertLocalDirectory(directory.path);
      }
      using _mount = mountAs(directory.path, 0x6969n);

      // Act
      const checking = assertLocalDirectory(directory.path);

      // Assert
      await assert.rejects(checking, NetworkDirectoryError);
    },
  );
});
