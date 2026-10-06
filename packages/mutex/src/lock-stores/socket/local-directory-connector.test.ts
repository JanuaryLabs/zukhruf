import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { sep } from 'node:path';
import { describe, mock, test } from 'node:test';

import { NetworkDirectoryError } from '../../local-directory/network-directory-error.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import type { ClientConnector } from '../remote/connector.ts';
import { LocalDirectoryConnector } from './local-directory-connector.ts';

const onLinux = {
  skip:
    process.platform === 'linux'
      ? false
      : 'Only Linux statfs reports a stable file system type',
};

/** A connector that only counts how often it is asked to connect, and never connects. */
function countingConnector() {
  const counted = { connects: 0 };
  const connector: ClientConnector = {
    async connect() {
      counted.connects++;
      return undefined;
    },
  };
  return { connector, counted };
}

/**
 * Makes statfs report `type` for `directory` and everything inside it, and
 * holds each such answer until `release`, as a slow mount would.
 */
function slowMount(directory: string, type: bigint) {
  const statfs = fsPromises.statfs;
  const asked = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  mock.method(
    fsPromises,
    'statfs',
    async (...args: Parameters<typeof fsPromises.statfs>) => {
      const path = String(args[0]);
      const stats = await statfs(...args);
      if (path !== directory && !path.startsWith(directory + sep)) return stats;
      asked.resolve();
      await released.promise;
      return Object.assign(stats, { type });
    },
  );
  syncBuiltinESMExports();
  return {
    asked: asked.promise,
    release: () => released.resolve(),
    [Symbol.dispose]() {
      released.resolve();
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

describe('LocalDirectoryConnector', () => {
  test(
    'a connect whose signal already aborted rejects with its reason, without judging the directory',
    onLinux,
    async () => {
      // Arrange: the directory looks like a network mount.
      await using directory = await scratchDirectory();
      using mount = slowMount(directory.path, 0x6969n);
      mount.release();
      const { connector: inner, counted } = countingConnector();
      const connector = new LocalDirectoryConnector(directory.path, inner);
      const reason = new Error('The store closed');

      // Act
      const connecting = connector.connect(AbortSignal.abort(reason));

      // Assert
      await assert.rejects(connecting, (error) => error === reason);
      assert.equal(counted.connects, 0);
    },
  );

  test(
    'a connect aborted while it judges the directory never reaches the connector it wraps',
    onLinux,
    async () => {
      // Arrange: the judgement of a local directory is slow to arrive.
      await using directory = await scratchDirectory();
      using mount = slowMount(directory.path, 0xef53n);
      const { connector: inner, counted } = countingConnector();
      const connector = new LocalDirectoryConnector(directory.path, inner);
      const abort = new AbortController();
      const connecting = connector.connect(abort.signal);
      await mount.asked;

      // Act: the store closes while the directory is judged.
      const reason = new Error('The store closed');
      abort.abort(reason);
      mount.release();

      // Assert
      await assert.rejects(connecting, (error) => error === reason);
      assert.equal(counted.connects, 0);
    },
  );

  test(
    'a directory on a network file system is refused before the wrapped connector is asked',
    onLinux,
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      using mount = slowMount(directory.path, 0x6969n);
      mount.release();
      const { connector: inner, counted } = countingConnector();
      const connector = new LocalDirectoryConnector(directory.path, inner);

      // Act
      const connecting = connector.connect(new AbortController().signal);

      // Assert
      await assert.rejects(connecting, NetworkDirectoryError);
      assert.equal(counted.connects, 0);
    },
  );
});
