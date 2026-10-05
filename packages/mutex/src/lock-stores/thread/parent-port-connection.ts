import type { MessagePort } from 'node:worker_threads';

import type { Connection, ConnectionHandlers } from '../remote/connection.ts';
import { unwrap, wrap } from '../remote/envelope.ts';
import type { LockRequest, LockResponse } from '../remote/protocol.ts';

/**
 * A worker thread's end of the message port to the thread that started it.
 * A `message` listener keeps the worker alive, so this adapter listens only
 * while referenced; messages that arrive meanwhile wait in the port. The
 * coordinator cannot stop without its workers stopping too, so `close` is
 * never reported.
 */
export class ParentPortConnection implements Connection<
  LockRequest,
  LockResponse
> {
  readonly #port: MessagePort;
  #handlers: ConnectionHandlers<LockResponse> | undefined;
  #listening = false;

  readonly #onMessage = (envelope: unknown) => {
    const response = unwrap<LockResponse>(envelope);
    if (response) this.#handlers?.message(response);
  };

  constructor(port: MessagePort) {
    this.#port = port;
  }

  async send(request: LockRequest): Promise<void> {
    this.#port.postMessage(wrap(request));
  }

  listen(handlers: ConnectionHandlers<LockResponse>) {
    this.#handlers = handlers;
  }

  ref() {
    if (this.#listening) return;
    this.#listening = true;
    this.#port.on('message', this.#onMessage);
  }

  unref() {
    if (!this.#listening) return;
    this.#listening = false;
    this.#port.off('message', this.#onMessage);
  }

  close() {
    this.unref();
  }
}
