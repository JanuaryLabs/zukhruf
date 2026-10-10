import { EventEmitter } from 'node:events';

import type { Connection, ConnectionEvents } from '../remote/connection.ts';
import { unwrap, wrap } from '../remote/envelope.ts';
import type { LockRequest } from '../remote/protocol.ts';

/**
 * The child's end of the IPC channel to its parent. Node counts `message` and
 * `disconnect` listeners to decide whether the channel keeps the process alive,
 * so this adapter listens only while referenced. That leaves the application's
 * own listeners in charge of the process lifetime. Messages that arrive while
 * not listening are buffered by Node and delivered on the next `ref`.
 */
export class ProcessChannelConnection
  extends EventEmitter<ConnectionEvents>
  implements Connection<LockRequest>
{
  /** `process.send`, which reports a send after the channel closed through its callback. */
  readonly #send: (envelope: unknown) => Promise<void>;

  readonly #onMessage = (envelope: unknown) => {
    const message = unwrap(envelope);
    if (message !== undefined) this.emit('message', message);
  };

  readonly #onDisconnect = () => {
    this.unref();
    this.emit('close');
  };

  constructor(send: (envelope: unknown) => Promise<void>) {
    super();
    this.#send = send;
  }

  send(request: LockRequest): Promise<void> {
    return this.#send(wrap(request));
  }

  /** Removes the listeners before it adds them, so a second `ref` does not listen twice. */
  ref() {
    this.unref();
    process.on('message', this.#onMessage);
    process.on('disconnect', this.#onDisconnect);
  }

  unref() {
    process.off('message', this.#onMessage);
    process.off('disconnect', this.#onDisconnect);
  }

  close() {
    this.unref();
  }
}
