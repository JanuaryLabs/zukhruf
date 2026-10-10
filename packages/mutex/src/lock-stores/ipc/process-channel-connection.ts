import { wrap } from '../remote/envelope.ts';
import type { LockRequest } from '../remote/protocol.ts';
import { SharedChannelConnection } from '../remote/shared-channel-connection.ts';

/**
 * The child's end of the IPC channel to its parent. Node counts `message` and
 * `disconnect` listeners to decide whether the channel keeps the process alive,
 * so this adapter listens only while referenced. That leaves the application's
 * own listeners in charge of the process lifetime. Messages that arrive while
 * not listening are buffered by Node and delivered on the next `ref`.
 */
export class ProcessChannelConnection extends SharedChannelConnection<LockRequest> {
  /** `process.send`, which reports a send after the channel closed through its callback. */
  readonly #send: (envelope: unknown) => Promise<void>;

  constructor(send: (envelope: unknown) => Promise<void>) {
    super(process, ['disconnect']);
    this.#send = send;
  }

  send(request: LockRequest): Promise<void> {
    return this.#send(wrap(request));
  }

  /** Removes the listeners before it adds them, so a second `ref` does not listen twice. */
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
