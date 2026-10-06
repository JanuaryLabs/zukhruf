import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';

import { LeaderElection } from '../../leader-election/leader-election.ts';
import type { Lease } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { ConnectionSupervisor } from '../remote/connection-supervisor.ts';
import { RemoteLockClient } from '../remote/remote-lock-client.ts';
import { ElectingConnector } from './electing-connector.ts';
import { LockServer } from './lock-server.ts';

/** macOS allows 104 bytes including the terminating NUL; Linux allows 108. */
const SOCKET_PATH_LIMIT = 103;

export type SocketRole = 'leader' | 'follower';

export interface SocketStoreOptions {
  /** Milliseconds between connection and campaign attempts. */
  pollInterval?: number;
  /**
   * Milliseconds a new leader grants nothing, so holders from the previous
   * term can reassert first. Must exceed how long a holder takes to reconnect.
   */
  graceWindow?: number;
}

/**
 * Host-wide locks granted by one elected process over a Unix socket in
 * `directory`. Every process using the store is a candidate: the first one to
 * need a lock with no leader serving wins the election and serves the rest
 * until it exits. When the leader dies, the kernel closes every connection,
 * a survivor takes over, and holders reassert their keys during the new
 * leader's grace window. Tokens carry the term's epoch, so a holder that
 * missed the window (for example while frozen) is fenced off by any resource
 * that checks tokens, and its lease ends with `LockLostError`.
 */
export class SocketStore
  extends EventEmitter<{ role: [SocketRole] }>
  implements LockStore, AsyncDisposable
{
  readonly #client: RemoteLockClient;
  #server: LockServer | undefined;
  #role: SocketRole | undefined;

  constructor(
    directory: string,
    { pollInterval = 10, graceWindow = 500 }: SocketStoreOptions = {},
  ) {
    super();
    const socketPath = socketPathFor(directory);
    this.#client = new RemoteLockClient(
      new ConnectionSupervisor(
        new ElectingConnector({
          socketPath,
          election: new LeaderElection(directory, { pollInterval }),
          pollInterval,
          serve: async (leadership) => {
            this.#server = await LockServer.start(socketPath, leadership, {
              // The first term of a directory has no predecessor to wait for.
              graceWindow: leadership.epoch > 1n ? graceWindow : 0,
            });
            this.#setRole('leader');
          },
          connected: () => {
            if (!this.#server) this.#setRole('follower');
          },
        }),
      ),
    );
  }

  /** Whether this process serves the locks, or `undefined` before it first needed one. */
  get role(): SocketRole | undefined {
    return this.#role;
  }

  acquire(key: string, options?: AcquireOptions): Promise<Lease> {
    return this.#client.acquire(key, options);
  }

  tryAcquire(key: string): Promise<Lease | undefined> {
    return this.#client.tryAcquire(key);
  }

  /** Stops a campaign still in progress first, so no lock server starts after disposal. */
  async [Symbol.asyncDispose]() {
    await this.#client.close();
    await this.#server?.close();
  }

  #setRole(role: SocketRole) {
    if (this.#role === role) return;
    this.#role = role;
    this.emit('role', role);
  }
}

/**
 * A Unix socket file in the directory on macOS and Linux. On Windows, a named
 * pipe: pipe names are global, so the name comes from the directory, and
 * Windows paths ignore case, so the path is lowercased first.
 */
function socketPathFor(directory: string): string {
  if (process.platform === 'win32') {
    const id = createHash('sha256')
      .update(resolve(directory).toLowerCase())
      .digest('hex')
      .slice(0, 32);
    return `\\\\.\\pipe\\mutex-${id}`;
  }
  const socketPath = join(directory, 'lock.sock');
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_LIMIT) {
    throw new RangeError(
      `The socket path ${socketPath} exceeds ${SOCKET_PATH_LIMIT} bytes; choose a shorter directory.`,
    );
  }
  return socketPath;
}
