import type { MessagePort } from 'node:worker_threads';

import type { ChannelOptions } from './envelope.ts';
import { SharedChannelConnection } from './shared-channel-connection.ts';

/**
 * A worker thread's end of the message port to the thread that started it.
 * A `message` listener keeps the worker alive, so this adapter listens only
 * while referenced; messages that arrive meanwhile wait in the port. The
 * starting thread cannot stop without its workers stopping too, so `close` is
 * never reported.
 */
export class ParentPortConnection<
  Outgoing,
> extends SharedChannelConnection<Outgoing> {
  readonly #port: MessagePort;

  constructor(port: MessagePort, options: ChannelOptions) {
    super(port, [], options);
    this.#port = port;
  }

  async send(message: Outgoing): Promise<void> {
    this.#port.postMessage(this.envelope.wrap(message));
  }

  /** Removes the listener before it adds it, so a second `ref` does not listen twice. */
  ref() {
    this.stopListening();
    this.listen();
  }

  unref() {
    this.stopListening();
  }

  async close() {
    this.unref();
  }
}
