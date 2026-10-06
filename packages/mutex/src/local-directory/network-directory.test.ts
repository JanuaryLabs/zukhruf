import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, { symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { describe, mock, test } from 'node:test';

import {
  LockFileStore,
  NetworkDirectoryError,
  type SocketRole,
  SocketStore,
} from '../index.ts';
import {
  LeaderElection,
  NetworkDirectoryError as LeaderElectionNetworkDirectoryError,
} from '../leader-election/index.ts';
import { scratchDirectory } from '../testing/scratch-directory.ts';
import { storeCases } from '../testing/store-cases.ts';
import { waitUntil } from '../testing/wait-until.ts';

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

const hostStores = storeCases.filter((store) => store.reach === 'host');

/** Whether `path` is `directory` itself or lies inside it. */
const within = (directory: string, path: string) =>
  path === directory || path.startsWith(directory + sep);

/**
 * Makes statfs report `type` for `directory` and everything inside it, as a
 * mount of that file system would. Every other path gets the real answer.
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

/** Makes statfs fail with `code` once for `directory`, as a flaky mount would; later calls get the real answer. */
function failStatfsOnce(directory: string, code: string) {
  const statfs = fsPromises.statfs;
  let failed = false;
  mock.method(
    fsPromises,
    'statfs',
    async (...args: Parameters<typeof fsPromises.statfs>) => {
      if (!failed && within(directory, String(args[0]))) {
        failed = true;
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

const outcome = (acquiring: Promise<AsyncDisposable>) =>
  acquiring.then(
    async (lease) => {
      await lease[Symbol.asyncDispose]();
      return 'granted' as const;
    },
    (error: unknown) => error,
  );

const onLinux = {
  skip:
    process.platform === 'linux'
      ? false
      : 'Only Linux statfs reports a stable file system type',
};

describe('A lock directory on a network file system', () => {
  for (const [fileSystem, type] of networkFileSystems) {
    for (const store of hostStores) {
      test(
        `${store.name} refuses a directory on ${fileSystem}`,
        onLinux,
        async () => {
          // Arrange
          await using directory = await scratchDirectory();
          using _mount = mountAs(directory.path, type);
          await using host = store.open(directory.path);

          // Act
          const failure = await host.store.acquire('product:42').then(
            async (lease) => {
              await lease[Symbol.asyncDispose]();
              return undefined;
            },
            (error: unknown) => error,
          );

          // Assert
          assert.ok(
            failure instanceof NetworkDirectoryError,
            `${store.name} must refuse a lock directory on ${fileSystem}, got ${String(failure)}`,
          );
          assert.equal(failure.fileSystem, fileSystem);
          assert.equal(failure.directory, directory.path);
        },
      );
    }
  }

  for (const [form, type] of [
    ['an unsigned 64-bit', 0xffffffffff534d42n],
    ['a negative', 0xff534d42n - 2n ** 32n],
  ] as const) {
    test(
      `a CIFS type read as ${form} number is still refused`,
      onLinux,
      async () => {
        // Arrange: CIFS's magic has its high bit set, so a signed f_type extends its sign.
        await using directory = await scratchDirectory();
        using _mount = mountAs(directory.path, type);
        const [store] = hostStores;
        assert.ok(store, 'The store matrix must have a host store');
        await using host = store.open(directory.path);

        // Act
        const failure = await host.store.acquire('product:42').then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert
        assert.ok(
          failure instanceof NetworkDirectoryError,
          `A sign-extended CIFS type must be refused, got ${String(failure)}`,
        );
        assert.equal(failure.fileSystem, 'CIFS');
      },
    );
  }

  for (const store of hostStores) {
    test(
      `${store.name} leaves a refused directory untouched`,
      onLinux,
      async () => {
        // Arrange
        await using directory = await scratchDirectory();
        using _mount = mountAs(directory.path, 0x6969n);
        await using host = store.open(directory.path);

        // Act
        await assert.rejects(
          host.store.acquire('product:42'),
          NetworkDirectoryError,
        );

        // Assert: nothing was campaigned for, served, or locked there.
        assert.deepEqual(await fsPromises.readdir(directory.path), []);
      },
    );
  }

  test(
    'a leader election refuses a directory on a network file system',
    onLinux,
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      using _mount = mountAs(directory.path, 0x6969n);

      // Act
      const campaigning = new LeaderElection(directory.path).campaign();

      // Assert: the leader-election entry point exports the same error class.
      await assert.rejects(campaigning, LeaderElectionNetworkDirectoryError);
      assert.equal(LeaderElectionNetworkDirectoryError, NetworkDirectoryError);
    },
  );

  for (const store of hostStores) {
    for (const [name, type] of [
      ['a FUSE mount', 0x65735546n],
      ['ext4', 0xef53n],
    ] as const) {
      test(
        `${store.name} keeps working in a directory on ${name}`,
        onLinux,
        async () => {
          // Arrange
          await using directory = await scratchDirectory();
          using _mount = mountAs(directory.path, type);
          await using host = store.open(directory.path);

          // Act
          const result = await outcome(host.store.acquire('product:42'));

          // Assert
          assert.equal(result, 'granted');
        },
      );
    }
  }

  test(
    'a directory that does not exist yet is judged by its nearest existing parent',
    onLinux,
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const notYet = join(directory.path, 'not', 'yet');
      using _mount = mountAs(directory.path, 0x6969n);
      const store = new LockFileStore(notYet);

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
    'a file system check that cannot run lets the lock go ahead, and is tried again next time',
    onLinux,
    async () => {
      // Arrange: statfs fails once, as it may in a sandbox or on a flaky mount.
      await using directory = await scratchDirectory();
      using _flaky = failStatfsOnce(directory.path, 'EIO');
      const store = new LockFileStore(directory.path);

      // Act
      const unjudged = await outcome(store.acquire('product:42'));
      using _mount = mountAs(directory.path, 0x6969n);
      const judged = await outcome(store.acquire('product:42'));

      // Assert: the failed check blocked nothing and was not remembered as a pass.
      assert.equal(
        unjudged,
        'granted',
        'A check that cannot run must not block the lock',
      );
      assert.ok(
        judged instanceof NetworkDirectoryError,
        `The next acquire must judge the directory again, got ${String(judged)}`,
      );
    },
  );

  test(
    'a directory that passed the check is not judged again',
    onLinux,
    async () => {
      // Arrange: the first acquire finds a local file system.
      await using directory = await scratchDirectory();
      const store = new LockFileStore(directory.path);
      assert.equal(await outcome(store.acquire('product:42')), 'granted');

      // Act: the same directory would now look like a network mount.
      using _mount = mountAs(directory.path, 0x6969n);
      const result = await outcome(store.acquire('product:42'));

      // Assert: the mount is live for a directory not yet judged, but the judged one is not asked again.
      await assert.rejects(
        new LockFileStore(join(directory.path, 'sibling')).acquire(
          'product:42',
        ),
        NetworkDirectoryError,
      );
      assert.equal(result, 'granted');
    },
  );

  test(
    'a socket store that fails over never judges its directory again, so its holders keep their keys',
    onLinux,
    async (t) => {
      // Arrange: a leader and a follower that holds a key, both past the check.
      await using directory = await scratchDirectory();
      const options = { pollInterval: 10, graceWindow: 50 };
      const leader = new SocketStore(directory.path, options);
      await using follower = new SocketStore(directory.path, options);
      try {
        await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
        const held = await follower.acquire('product:42');
        const roles: SocketRole[] = [];
        follower.on('role', (role) => roles.push(role));

        // Act: the leader stops while the directory would now look like a network mount.
        using _mount = mountAs(directory.path, 0x6969n);
        await leader[Symbol.asyncDispose]();
        await waitUntil(
          t,
          () => roles.includes('leader'),
          'The follower must take over as leader',
        );

        // Assert: the mount is live, yet the takeover did not judge the directory again, so the holder never lost its key.
        await assert.rejects(
          new LockFileStore(join(directory.path, 'sibling')).acquire(
            'product:42',
          ),
          NetworkDirectoryError,
        );
        await held[Symbol.asyncDispose]();
      } finally {
        await leader[Symbol.asyncDispose]();
      }
    },
  );

  test(
    'macOS never refuses a directory by its statfs number',
    {
      skip:
        process.platform === 'darwin'
          ? false
          : 'Only macOS numbers its file systems as they load',
    },
    async () => {
      // Arrange: a local directory whose number matches NFS on Linux.
      await using directory = await scratchDirectory();
      using _mount = mountAs(directory.path, 0x6969n);
      const store = new LockFileStore(directory.path);

      // Act
      const result = await outcome(store.acquire('product:42'));

      // Assert
      assert.equal(result, 'granted');
    },
  );

  for (const share of [
    String.raw`\\server\share\locks`,
    String.raw`\\?\UNC\server\share\locks`,
    String.raw`\\.\UNC\server\share\locks`,
    '//server/share/locks',
  ]) {
    test(
      `Windows refuses the network share ${share}`,
      {
        skip:
          process.platform === 'win32'
            ? false
            : 'UNC paths exist only on Windows',
      },
      async () => {
        // Arrange: the guard judges the path itself, so the share need not exist.
        const store = new LockFileStore(share);

        // Act
        const result = await outcome(store.acquire('product:42'));

        // Assert
        assert.ok(
          result instanceof NetworkDirectoryError,
          `got ${String(result)}`,
        );
      },
    );
  }

  test(
    'Windows keeps working in a local directory named with the \\\\?\\ prefix',
    {
      skip:
        process.platform === 'win32'
          ? false
          : 'The prefix exists only on Windows',
    },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const store = new LockFileStore('\\\\?\\' + directory.path);

      // Act
      const result = await outcome(store.acquire('product:42'));

      // Assert
      assert.equal(result, 'granted');
    },
  );

  for (const store of hostStores) {
    test(
      `${store.name} refuses a try on a network directory too`,
      onLinux,
      async () => {
        // Arrange
        await using directory = await scratchDirectory();
        using _mount = mountAs(directory.path, 0x6969n);
        await using host = store.open(directory.path);

        // Act
        const trying = host.store.tryAcquire('product:42');

        // Assert
        await assert.rejects(trying, NetworkDirectoryError);
      },
    );
  }

  test(
    'a leader election does not create a refused directory',
    onLinux,
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const notYet = join(directory.path, 'not', 'yet');
      using _mount = mountAs(directory.path, 0x6969n);

      // Act
      const campaigning = new LeaderElection(notYet).campaign();

      // Assert
      await assert.rejects(campaigning, NetworkDirectoryError);
      assert.deepEqual(await fsPromises.readdir(directory.path), []);
    },
  );

  test(
    'a socket store refuses a network directory even when a leader already serves it',
    onLinux,
    async () => {
      // Arrange: a leader serves the directory; a second store reaches it through a
      // symlink that looks like a network mount, so it would follow without campaigning.
      await using directory = await scratchDirectory();
      const options = { pollInterval: 10, graceWindow: 50 };
      await using leader = new SocketStore(directory.path, options);
      await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
      const viaShare = join(directory.path, 'share');
      await symlink(directory.path, viaShare);
      using _mount = mountAs(viaShare, 0x6969n);
      await using follower = new SocketStore(viaShare, options);

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
