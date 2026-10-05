import type { ChildProcess } from 'node:child_process';

import type { Connection, ConnectionHandlers } from '../remote/connection.ts';
import { unwrap, wrap } from '../remote/envelope.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockRequest,
} from '../remote/protocol.ts';

/**
 * The parent's end of the IPC channel to one child. The kernel closes the
 * channel when the child dies, so `disconnect` reports even a SIGKILL.
 */
export class ChildProcessConnection implements Connection<
  LockResponse,
  LockRequest
> {
  readonly #child: ChildProcess;
  #detach = () => {};

  constructor(child: ChildProcess) {
    this.#child = child;
  }

  send(response: LockResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#child.connected) {
        reject(new Error('The child process has disconnected.'));
        return;
      }
      this.#child.send(wrap(response), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  listen({ message, close }: ConnectionHandlers<LockRequest>) {
    const onMessage = (envelope: unknown) => {
      const request = unwrap(envelope);
      if (isLockRequest(request)) message(request);
    };
    const onDisconnect = () => {
      this.close();
      close();
    };
    this.#child.on('message', onMessage);
    this.#child.once('disconnect', onDisconnect);
    this.#detach = () => {
      this.#child.off('message', onMessage);
      this.#child.off('disconnect', onDisconnect);
    };
  }

  /** The running child already keeps the parent alive. */
  ref() {}

  unref() {}

  close() {
    this.#detach();
  }
}
