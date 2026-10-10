import type { MessagePort } from 'node:worker_threads';

import { wrap } from '../remote/envelope.ts';
import type { LockRequest } from '../remote/protocol.ts';
import { SharedChannelConnection } from '../remote/shared-channel-connection.ts';

/**
 * A worker thread's end of the message port to the thread that started it.
 * A `message` listener keeps the worker alive, so this adapter listens only
 * while referenced; messages that arrive meanwhile wait in the port. The
 * coordinator cannot stop without its workers stopping too, so `close` is
 * never reported.
 */
export class ParentPortConnection extends SharedChannelConnection<LockRequest> {
  readonly #port: MessagePort;

  constructor(port: MessagePort) {
    super(port, []);
    this.#port = port;
  }

  async send(request: LockRequest): Promise<void> {
    this.#port.postMessage(wrap(request));
  }

  /** Removes the listener before it adds it, so a second `ref` does not listen twice. */
  ref() {
    this.stopListening();
    this.listen();
  }

  unref() {
    this.stopListening();
  }

  close() {
    this.unref();
  }
}
