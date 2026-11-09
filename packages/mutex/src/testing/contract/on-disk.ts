import assert from 'node:assert/strict';
import fsPromises, { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { describe, test } from '@zukhruf/testing/node';

import { NetworkDirectoryError } from '../../lock-stores/file-system/index.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { mountAs, networkFileSystems, onLinux } from '../network-mount.ts';
import { newProcessTimeout } from '../new-process-timeout.ts';
import { outcome } from '../outcome.ts';
import { startWorker } from '../worker-process.ts';
import { holderSource } from './peers.ts';
import type { Host, OnDisk, SharedByProcesses, Subject } from './subject.ts';

/** Each file under `directory` with its inode, size and change time, so that any write shows. */
async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        const { ino, size, mtimeNs } = await stat(path, { bigint: true });
        return `${relative(directory, path)} ${ino} ${size} ${mtimeNs}`;
      }),
  );
  return files.sort();
}

/** A host lock store: its locks are files in its directory. */
export function onDisk<H extends Host>(
  store: Subject<H>,
  disk: OnDisk<H>,
): void {
  describe('A lock directory on a network file system', () => {
    void test.each(networkFileSystems, ([fileSystem, type]) =>
      test(
        `${store.name} refuses a directory on ${fileSystem}`,
        onLinux,
        async (t) => {
          // Arrange
          await using directory = await new TemporaryFiles().directory(
            'mutex-test-',
          );
          using _mount = mountAs(t, directory.path, type);
          await using host = disk.openIn(directory.path);

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
      ),
    );

    test(
      `${store.name} leaves a refused directory untouched`,
      onLinux,
      async (t) => {
        // Arrange
        await using directory = await new TemporaryFiles().directory(
          'mutex-test-',
        );
        using _mount = mountAs(t, directory.path, 0x6969n);
        await using host = disk.openIn(directory.path);

        // Act
        await assert.rejects(
          host.store.acquire('product:42'),
          NetworkDirectoryError,
        );

        // Assert: nothing was campaigned for, served, or locked there.
        assert.deepEqual(await fsPromises.readdir(directory.path), []);
      },
    );

    void test.each(
      [
        ['a FUSE mount', 0x65735546n],
        ['ext4', 0xef53n],
      ] as const,
      ([name, type]) =>
        test(
          `${store.name} keeps working in a directory on ${name}`,
          onLinux,
          async (t) => {
            // Arrange
            await using directory = await new TemporaryFiles().directory(
              'mutex-test-',
            );
            using _mount = mountAs(t, directory.path, type);
            await using host = disk.openIn(directory.path);

            // Act
            const result = await outcome(host.store.acquire('product:42'));

            // Assert
            assert.equal(result, 'granted');
          },
        ),
    );

    test(
      `${store.name} refuses a try on a network directory too`,
      onLinux,
      async (t) => {
        // Arrange
        await using directory = await new TemporaryFiles().directory(
          'mutex-test-',
        );
        using _mount = mountAs(t, directory.path, 0x6969n);
        await using host = disk.openIn(directory.path);

        // Act
        const trying = host.store.tryAcquire('product:42');

        // Assert
        await assert.rejects(trying, NetworkDirectoryError);
      },
    );
  });

  describe(`Holder check with ${store.name}`, () => {
    test('looks change no file', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const lookTwenty = async () => {
        for (let look = 0; look < 20; look++) {
          await mutex.isHeld('report:daily');
        }
      };

      // Act: look while the key is held, then while it is free.
      const held = await mutex.acquire('report:daily', async () => {
        const files = await filesIn(fixture.location);
        await lookTwenty();
        return { files, filesAfterLooks: await filesIn(fixture.location) };
      });
      const files = await filesIn(fixture.location);
      await lookTwenty();
      const filesAfterLooks = await filesIn(fixture.location);

      // Assert
      assert.deepEqual(
        held.filesAfterLooks,
        held.files,
        'Looks at a held key must not write',
      );
      assert.deepEqual(
        filesAfterLooks,
        files,
        'Looks at a free key must not write',
      );
    });
  });
}

/** A host lock store whose look reads and writes nothing. */
export function passiveLooks<H extends Host>(
  store: Subject<H>,
  disk: OnDisk<H>,
  sharing: SharedByProcesses<H>,
): void {
  describe(`Holder check in a directory that does not exist with ${store.name}`, () => {
    test('a look answers that nobody holds the key, and makes no directory', async () => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const locks = join(directory.path, 'locks');
      await using host = disk.openIn(locks);
      const mutex = new Mutex(host.store);

      // Act
      const held = await mutex.isHeld('report:daily');

      // Assert
      assert.equal(held, false);
      assert.deepEqual(await readdir(directory.path), []);
    });
  });
  describe(`Holder check across processes with ${store.name}`, () => {
    test('a look leaves the files of a killed holder as they are', async (t) => {
      // Arrange: a holder process dies while it holds the key, and leaves its files.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      await using holder = startWorker(
        holderSource(sharing.module, fixture.location),
        'holder',
        { admit: (child) => sharing.admit(host, child) },
      );
      await t.waitFor(
        () =>
          assert.ok(
            holder.has('entered'),
            `The holder process must enter its task.\n${holder.stderr}`,
          ),
        { interval: 5, timeout: newProcessTimeout },
      );
      holder.child.kill('SIGKILL');
      await holder.closed;
      const mutex = new Mutex(host.store);
      const files = await filesIn(fixture.location);

      // Act
      for (let look = 0; look < 5; look++) {
        await mutex.isHeld('report:daily');
      }

      // Assert: only a caller that acquires removes a gone holder.
      assert.deepEqual(await filesIn(fixture.location), files);
    });
  });
}
