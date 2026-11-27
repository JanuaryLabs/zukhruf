import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

import type { Clock } from '@zukhruf/async';
import { PipeEndpoint } from '@zukhruf/pipes';
import { ConnectionSupervisor } from '@zukhruf/rpc';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { RemoteLockClient } from '../remote/remote-lock-client.ts';
import { ElectingConnector } from './electing-connector.ts';
import { LocalDirectoryConnector } from './local-directory-connector.ts';
import { LockServer } from './lock-server.ts';
import { RecordingConnector } from './recording-connector.ts';
import { SessionDirectory } from './session-directory.ts';
import { socketElection } from './socket-election.ts';

export type SocketRole = 'leader' | 'follower';

export interface SocketStoreOptions {
  /**
   * The longest silence, in milliseconds, that the other processes accept
   * from this process. A follower ends a leader that is silent for longer,
   * for example one stopped with SIGSTOP, and a survivor takes over. A new
   * leader after a failover ends the recovery of this session when it sends
   * no end-of-reasserts marker for longer, and then refuses its reasserts
   * (ADR 0033). The default, 15000, is the one of `SqliteElection`.
   */
  leaseDuration?: number;
  /** The clock of every wait of the store: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

/**
 * Host-wide locks granted by one elected process over a Unix socket in
 * `directory`. Every process using the store is a candidate: the first one to
 * need a lock with no leader serving wins the election and serves the rest
 * until it exits. Each store is a session with a record in the directory.
 * When the leader dies, the kernel closes every connection, a survivor takes
 * over, and the new leader grants nothing until each recorded session
 * reasserted its keys, stopped, or missed its lease duration. Tokens carry
 * the term's epoch, so a holder that missed its lease duration (for example
 * while frozen) is fenced off by any resource that checks tokens, and its
 * lease's signal aborts with `LeaseLostError`.
 */
export class SocketStore
  extends EventEmitter<{ role: [SocketRole] }>
  implements LockStore, AsyncDisposable
{
  readonly #client: RemoteLockClient;
  readonly #recording: RecordingConnector;
  /** The lock servers this process started; disposing the store closes them. */
  readonly #servers = new AsyncDisposableStack();

  constructor(
    directory: string,
    { leaseDuration = 15_000, clock }: SocketStoreOptions,
  ) {
    super();
    const session = randomUUID();
    const sessions = new SessionDirectory(directory, clock);
    // A Unix socket file in the directory on macOS and Linux; on Windows, a named pipe named by a hash of that path.
    const endpoint = new PipeEndpoint(resolve(directory, 'lock.sock'), {
      prefix: 'zukhruf-mutex',
    });
    this.#recording = new RecordingConnector(
      sessions,
      session,
      leaseDuration,
      new ElectingConnector({
        address: endpoint.address,
        election: socketElection(directory, clock, leaseDuration),
        clock,
        session,
        serve: async (term) => {
          // Until serving has fully started, a failure closes the new server, so no server outlives its term.
          await using starting = new AsyncDisposableStack();
          starting.adopt(
            await LockServer.start(endpoint, term, {
              // The first term of a directory has no predecessor to wait for,
              // and a term after a clean shutdown has no holder to wait for.
              recovery:
                term.epoch > 1n && !term.afterCleanShutdown
                  ? { sessions, own: session, clock }
                  : undefined,
            }),
            (started) => started.close(),
          );
          this.emit('role', 'leader');
          this.#servers.use(starting.move());
        },
        connected: () => this.emit('role', 'follower'),
      }),
    );
    this.#client = new RemoteLockClient(
      new ConnectionSupervisor(
        new LocalDirectoryConnector(directory, this.#recording),
      ),
    );
  }

  acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#client.acquire(key, options);
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#client.tryAcquire(key);
  }

  isHeld(key: string): Promise<boolean> {
    return this.#client.isHeld(key);
  }

  /**
   * Stops a campaign still in progress first, so no lock server starts after
   * disposal. The client then holds no key, so the session record goes before
   * the term ends: the next leader never waits for this store.
   */
  async [Symbol.asyncDispose]() {
    await this.#client.close();
    try {
      await this.#recording[Symbol.asyncDispose]();
    } finally {
      await this.#servers.disposeAsync();
    }
  }
}
