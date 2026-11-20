import type { ChildProcess, Serializable } from 'node:child_process';
import { promisify } from 'node:util';

import { isErrno } from '@zukhruf/fs';

import { ConnectionClosedError } from '../remote/connection-closed-error.ts';
import { wrap } from '../remote/envelope.ts';
import type { LockResponse } from '../remote/protocol.ts';
import { SharedChannelConnection } from '../remote/shared-channel-connection.ts';

/**
 * The parent's end of the IPC channel to one child. The kernel closes the
 * channel when the child dies, so `disconnect` reports even a SIGKILL.
 */
export class ChildProcessConnection extends SharedChannelConnection<LockResponse> {
  /** A send after the channel closed reports the error through its callback. */
  readonly #send: (envelope: Serializable) => Promise<void>;

  constructor(child: ChildProcess) {
    super(child, ['disconnect']);
    this.#send = promisify<Serializable, void>(child.send).bind(child);
    this.listen();
  }

  async send(response: LockResponse): Promise<void> {
    try {
      await this.#send(wrap(response));
    } catch (error) {
      // A send to a child that died fails with EPIPE, and one after the channel closed with ERR_IPC_CHANNEL_CLOSED.
      if (isErrno(error, 'EPIPE') || isErrno(error, 'ERR_IPC_CHANNEL_CLOSED')) {
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
