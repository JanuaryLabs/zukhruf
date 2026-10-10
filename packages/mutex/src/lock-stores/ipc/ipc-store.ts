import { promisify } from 'node:util';

import { ConnectionSupervisor } from '../remote/connection-supervisor.ts';
import type { ClientConnection, ClientConnector } from '../remote/connector.ts';
import { DelegatingLockStore } from '../remote/delegating-lock-store.ts';
import { RemoteLockClient } from '../remote/remote-lock-client.ts';
import { ProcessChannelConnection } from './process-channel-connection.ts';

/** The channel to the parent cannot be re-established, so it is handed out once. */
class ProcessChannelConnector implements ClientConnector {
  readonly #channel: Iterator<ProcessChannelConnection, undefined>;

  constructor(channel: ProcessChannelConnection) {
    this.#channel = [channel].values();
  }

  async connect(): Promise<ClientConnection | undefined> {
    if (!process.connected) return undefined;
    return this.#channel.next().value;
  }
}

/**
 * The child-process side of `IpcLockCoordinator`: asks the parent for keys over
 * the IPC channel. If the parent dies, waiting acquires reject with
 * `CoordinatorUnavailableError`; held keys stay exclusive, because no
 * coordinator is left to grant them to anyone else.
 */
export class IpcStore extends DelegatingLockStore {
  constructor() {
    if (!process.send) {
      throw new Error(
        'IpcStore needs an IPC channel to its parent; start this process with fork() or an "ipc" stdio entry.',
      );
    }
    const channel = new ProcessChannelConnection(
      promisify<unknown, void>(process.send).bind(process),
    );
    super(
      new RemoteLockClient(
        new ConnectionSupervisor(new ProcessChannelConnector(channel)),
      ),
    );
  }
}
