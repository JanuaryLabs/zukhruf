import { promisify } from 'node:util';

import { ConnectionSupervisor, ProcessChannelConnection } from '@zukhruf/rpc';

import { DelegatingLockStore } from '../remote/delegating-lock-store.ts';
import {
  type ClientConnection,
  type ClientConnector,
  type LockRequest,
  lockChannel,
} from '../remote/protocol.ts';
import { RemoteLockClient } from '../remote/remote-lock-client.ts';

/** The channel to the parent cannot be re-established, so it is handed out once. */
class ProcessChannelConnector implements ClientConnector {
  readonly #channel: Iterator<ClientConnection, undefined>;

  constructor(channel: ClientConnection) {
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
    const channel = new ProcessChannelConnection<LockRequest>(
      promisify<unknown, void>(process.send).bind(process),
      lockChannel,
    );
    super(
      new RemoteLockClient(
        new ConnectionSupervisor(new ProcessChannelConnector(channel)),
      ),
    );
  }
}
