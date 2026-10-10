import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { SqliteElection } from '@zukhruf/election';
import type { FileLock } from '@zukhruf/fs';
import { LeaseLostError } from '@zukhruf/lease';

import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { LockServer } from './lock-server.ts';
import { type SocketRole, SocketStore } from './socket-store.ts';

/**
 * The election of the socket stores, with a backend that takes the claim
 * away when `loss` aborts. SQLite never takes a claim from a living leader,
 * so only such a backend can show what a server does with a lost term.
 */
class LosableElection extends SqliteElection {
  readonly #loss: AbortSignal;

  constructor(directory: string, loss: AbortSignal) {
    super({
      directory,
      claimFile: 'leader.lock',
      epochFile: 'leader.epoch',
      pollInterval: 10,
    });
    this.#loss = loss;
  }

  // The parameters are optional because SqliteElection's watch declares none.
  protected override watch(
    _claim?: FileLock,
    lose?: (reason: Error) => void,
  ): Disposable {
    return addAbortListener(this.#loss, () =>
      lose?.(new Error('The backend took the claim away')),
    );
  }
}

/** Whether anything listens on `socketPath`. */
function listening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const onUnixSockets = {
  skip:
    process.platform === 'win32'
      ? 'The server listens on the Unix socket path'
      : false,
};

describe('Lock server', () => {
  test(
    'a lock server started for a term that is already lost rejects with LeaseLostError and leaves nothing listening',
    onUnixSockets,
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      const socketPath = join(directory.path, 'lock.sock');
      const loss = new AbortController();
      const term = await new LosableElection(
        directory.path,
        loss.signal,
      ).campaign();
      assert.ok(term, 'The first campaign in an empty directory must win');
      loss.abort();

      // Act
      const starting = LockServer.start(socketPath, term, { graceWindow: 0 });

      // Assert
      await assert.rejects(starting, LeaseLostError);
      assert.equal(
        await listening(socketPath),
        false,
        'A server for a lost term must not serve',
      );
    },
  );

  test(
    'a lock server whose term is lost closes without close(), and a follower then leads at a higher epoch',
    onUnixSockets,
    async (t) => {
      // Arrange: a server for a term its backend can take away, and a store that follows it.
      await using directory = await scratchDirectory();
      const loss = new AbortController();
      const term = await new LosableElection(
        directory.path,
        loss.signal,
      ).campaign();
      assert.ok(term, 'The first campaign in an empty directory must win');
      const server = await LockServer.start(
        join(directory.path, 'lock.sock'),
        term,
        { graceWindow: 0 },
      );
      try {
        await using store = new SocketStore(directory.path, {
          pollInterval: 10,
          graceWindow: 50,
        });
        const roles: SocketRole[] = [];
        store.on('role', (role) => roles.push(role));
        await (await store.acquire('warm-up'))[Symbol.asyncDispose]();

        // Act
        loss.abort();

        // Assert: the server dropped its follower, which then won the next term.
        await waitUntil(
          t,
          () => roles.includes('leader'),
          'The follower must lead once the server of the lost term closes',
        );
        assert.deepEqual(roles, ['follower', 'leader']);
        const lease = await store.acquire('product:42');
        await lease[Symbol.asyncDispose]();
        assert.ok(
          lease.token.value >> 32n > term.epoch,
          `The new leader's token ${lease.token} must carry an epoch above the lost term's ${term.epoch}`,
        );
      } finally {
        await server.close();
      }
    },
  );
});
