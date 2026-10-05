import type { Connection, ConnectionHandlers } from '../remote/connection.ts';
import { unwrap, wrap } from '../remote/envelope.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockResponse,
} from '../remote/protocol.ts';

/**
 * The child's end of the IPC channel to its parent. Node counts `message` and
 * `disconnect` listeners to decide whether the channel keeps the process alive,
 * so this adapter listens only while referenced. That leaves the application's
 * own listeners in charge of the process lifetime. Messages that arrive while
 * not listening are buffered by Node and delivered on the next `ref`.
 */
export class ProcessChannelConnection implements Connection<
  LockRequest,
  LockResponse
> {
  #handlers: ConnectionHandlers<LockResponse> | undefined;
  #listening = false;

  readonly #onMessage = (envelope: unknown) => {
    const response = unwrap(envelope);
    if (isLockResponse(response)) this.#handlers?.message(response);
  };

  readonly #onDisconnect = () => {
    this.unref();
    this.#handlers?.close();
  };

  send(request: LockRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!process.send || !process.connected) {
        reject(new Error('The IPC channel to the parent is closed.'));
        return;
      }
      process.send(wrap(request), undefined, {}, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  listen(handlers: ConnectionHandlers<LockResponse>) {
    this.#handlers = handlers;
  }

  ref() {
    if (this.#listening) return;
    this.#listening = true;
    process.on('message', this.#onMessage);
    process.on('disconnect', this.#onDisconnect);
  }

  unref() {
    if (!this.#listening) return;
    this.#listening = false;
    process.off('message', this.#onMessage);
    process.off('disconnect', this.#onDisconnect);
  }

  close() {
    this.unref();
  }
}
