import { type MessagePort, parentPort } from 'node:worker_threads';

import { ConnectionSupervisor, ParentPortConnection } from '@zukhruf/rpc';

import { DelegatingLockStore } from '../remote/delegating-lock-store.ts';
import {
  type ClientConnection,
  type ClientConnector,
  type LockRequest,
  lockChannel,
} from '../remote/protocol.ts';
import { RemoteLockClient } from '../remote/remote-lock-client.ts';

/** A worker has one port to its parent thread for its whole life. */
class ParentPortConnector implements ClientConnector {
  readonly #connection: Iterator<ClientConnection, undefined>;

  constructor(port: MessagePort) {
    this.#connection = [
      new ParentPortConnection<LockRequest>(port, lockChannel),
    ].values();
  }

  async connect(): Promise<ClientConnection | undefined> {
    return this.#connection.next().value;
  }
}

/**
 * The worker-thread side of `ThreadLockCoordinator`: asks the thread that
 * started this worker for keys, through the worker's message port.
 */
export class ThreadStore extends DelegatingLockStore {
  constructor() {
    if (!parentPort) {
      throw new Error(
        'ThreadStore runs in a worker thread; use ThreadLockCoordinator in the thread that starts the workers.',
      );
    }
    super(
      new RemoteLockClient(
        new ConnectionSupervisor(new ParentPortConnector(parentPort)),
      ),
    );
  }
}
