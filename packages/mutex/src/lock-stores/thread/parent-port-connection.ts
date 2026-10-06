import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';

import type { Connection, ConnectionEvents } from '../remote/connection.ts';
import { unwrap, wrap } from '../remote/envelope.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockResponse,
} from '../remote/protocol.ts';

/**
 * A worker thread's end of the message port to the thread that started it.
 * A `message` listener keeps the worker alive, so this adapter listens only
 * while referenced; messages that arrive meanwhile wait in the port. The
 * coordinator cannot stop without its workers stopping too, so `close` is
 * never reported.
 */
export class ParentPortConnection
  extends EventEmitter<ConnectionEvents<LockResponse>>
  implements Connection<LockRequest, LockResponse>
{
  readonly #port: MessagePort;

  readonly #onMessage = (envelope: unknown) => {
    const response = unwrap(envelope);
    if (isLockResponse(response)) this.emit('message', response);
  };

  constructor(port: MessagePort) {
    super();
    this.#port = port;
  }

  async send(request: LockRequest): Promise<void> {
    this.#port.postMessage(wrap(request));
  }

  /** Removes the listener before it adds it, so a second `ref` does not listen twice. */
  ref() {
    this.unref();
    this.#port.on('message', this.#onMessage);
  }

  unref() {
    this.#port.off('message', this.#onMessage);
  }

  close() {
    this.unref();
  }
}
