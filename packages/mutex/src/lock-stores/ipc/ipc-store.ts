import type { Lease } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import type { ClientConnection, Connector } from '../remote/connector.ts';
import { RemoteLockClient } from '../remote/remote-lock-client.ts';
import { ProcessChannelConnection } from './process-channel-connection.ts';

/** The channel to the parent cannot be re-established, so it is handed out once. */
class ProcessChannelConnector implements Connector {
  #handedOut = false;

  async connect(): Promise<ClientConnection | undefined> {
    if (this.#handedOut || !process.connected) return undefined;
    this.#handedOut = true;
    return new ProcessChannelConnection();
  }
}

/**
 * The child-process side of `IpcLockCoordinator`: asks the parent for keys over
 * the IPC channel. If the parent dies, waiting acquires reject with
 * `CoordinatorUnavailableError`; held keys stay exclusive, because no
 * coordinator is left to grant them to anyone else.
 */
export class IpcStore implements LockStore {
  readonly #client: RemoteLockClient;

  constructor() {
    if (!process.send) {
      throw new Error(
        'IpcStore needs an IPC channel to its parent; start this process with fork() or an "ipc" stdio entry.',
      );
    }
    this.#client = new RemoteLockClient(new ProcessChannelConnector());
  }

  acquire(key: string, options?: AcquireOptions): Promise<Lease> {
    return this.#client.acquire(key, options);
  }

  tryAcquire(key: string): Promise<Lease | undefined> {
    return this.#client.tryAcquire(key);
  }
}
