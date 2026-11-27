import type { ChildProcess, Serializable } from 'node:child_process';
import { promisify } from 'node:util';

import { ConnectionClosedError } from '../connection/connection-closed-error.ts';
import type { ChannelOptions } from './envelope.ts';
import { SharedChannelConnection } from './shared-channel-connection.ts';

/** A send to a child that died fails with EPIPE, and one after the channel closed with ERR_IPC_CHANNEL_CLOSED. */
const closedCodes = new Set(['EPIPE', 'ERR_IPC_CHANNEL_CLOSED']);

/**
 * The parent's end of the IPC channel to one child. The kernel closes the
 * channel when the child dies, so `disconnect` reports even a SIGKILL.
 */
export class ChildProcessConnection<
  Outgoing,
> extends SharedChannelConnection<Outgoing> {
  /** A send after the channel closed reports the error through its callback. */
  readonly #send: (envelope: Serializable) => Promise<void>;

  constructor(child: ChildProcess, options: ChannelOptions) {
    super(child, ['disconnect'], options);
    this.#send = promisify<Serializable, void>(child.send).bind(child);
    this.listen();
  }

  async send(message: Outgoing): Promise<void> {
    try {
      await this.#send(this.envelope.wrap(message));
    } catch (error) {
      if (
        Error.isError(error) &&
        'code' in error &&
        typeof error.code === 'string' &&
        closedCodes.has(error.code)
      ) {
        throw new ConnectionClosedError({ cause: error });
      }
      throw error;
    }
  }

  /** The running child already keeps the parent alive. */
  ref() {}

  unref() {}

  async close() {
    this.stopListening();
  }
}
