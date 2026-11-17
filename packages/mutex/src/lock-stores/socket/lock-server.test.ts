import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { SqliteElection } from '@zukhruf/election';
import { TemporaryFiles } from '@zukhruf/fs';
import { LeaseLostError } from '@zukhruf/lease';
import { PipeEndpoint } from '@zukhruf/pipes';
import { waitFor } from '@zukhruf/testing/async';

import { onUnixSockets } from '../../testing/on-unix-sockets.ts';
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
      clock: globalThis,
      directory,
      claimFile: 'leader.lock',
      epochFile: 'leader.epoch',
    });
    this.#loss = loss;
  }

  // The parameters are optional because SqliteElection's watch declares none.
  protected override watch(
    _claim?: unknown,
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

describe('Lock server', () => {
  test(
    'a lock server started for a term that is already lost rejects with LeaseLostError and leaves nothing listening',
    onUnixSockets,
    async () => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const socketPath = join(directory.path, 'lock.sock');
      const loss = new AbortController();
      const term = await new LosableElection(
        directory.path,
        loss.signal,
      ).campaign();
      assert.ok(term, 'The first campaign in an empty directory must win');
      loss.abort();

      // Act
      const starting = LockServer.start(
        new PipeEndpoint(socketPath, { prefix: 'zukhruf-mutex' }),
        term,
        { grace: undefined },
      );

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
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const loss = new AbortController();
      const term = await new LosableElection(
        directory.path,
        loss.signal,
      ).campaign();
      assert.ok(term, 'The first campaign in an empty directory must win');
      const server = await LockServer.start(
        new PipeEndpoint(join(directory.path, 'lock.sock'), {
          prefix: 'zukhruf-mutex',
        }),
        term,
        { grace: undefined },
      );
      try {
        await using store = new SocketStore(directory.path, {
          clock: globalThis,
          graceWindow: 50,
        });
        const roles: SocketRole[] = [];
        store.on('role', (role) => roles.push(role));
        await (await store.acquire('warm-up'))[Symbol.asyncDispose]();

        // Act
        loss.abort();

        // Assert: the server dropped its follower, which then won the next term.
        await waitFor(
          () =>
            assert.ok(
              roles.includes('leader'),
              'The follower must lead once the server of the lost term closes',
            ),
          { signal: t.signal },
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
