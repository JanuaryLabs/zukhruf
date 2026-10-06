import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { Connection, ConnectionEvents } from '../remote/connection.ts';
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
export class ChildProcessConnection
  extends EventEmitter<ConnectionEvents<LockRequest>>
  implements Connection<LockResponse, LockRequest>
{
  readonly #child: ChildProcess;

  readonly #onMessage = (envelope: unknown) => {
    const request = unwrap(envelope);
    if (isLockRequest(request)) this.emit('message', request);
  };

  readonly #onDisconnect = () => {
    this.close();
    this.emit('close');
  };

  constructor(child: ChildProcess) {
    super();
    this.#child = child;
    child.on('message', this.#onMessage);
    child.once('disconnect', this.#onDisconnect);
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

  /** The running child already keeps the parent alive. */
  ref() {}

  unref() {}

  close() {
    this.#child.off('message', this.#onMessage);
    this.#child.off('disconnect', this.#onDisconnect);
  }
}
