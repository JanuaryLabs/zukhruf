import type { ChannelOptions } from './envelope.ts';
import { SharedChannelConnection } from './shared-channel-connection.ts';

/**
 * The child's end of the IPC channel to its parent. Node counts `message` and
 * `disconnect` listeners to decide whether the channel keeps the process alive,
 * so this adapter listens only while referenced. That leaves the application's
 * own listeners in charge of the process lifetime. Messages that arrive while
 * not listening are buffered by Node and delivered on the next `ref`.
 */
export class ProcessChannelConnection<
  Outgoing,
> extends SharedChannelConnection<Outgoing> {
  /** `process.send`, which reports a send after the channel closed through its callback. */
  readonly #send: (envelope: unknown) => Promise<void>;

  constructor(
    send: (envelope: unknown) => Promise<void>,
    options: ChannelOptions,
  ) {
    super(process, ['disconnect'], options);
    this.#send = send;
  }

  send(message: Outgoing): Promise<void> {
    return this.#send(this.envelope.wrap(message));
  }

  /** Removes the listeners before it adds them, so a second `ref` does not listen twice. */
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
