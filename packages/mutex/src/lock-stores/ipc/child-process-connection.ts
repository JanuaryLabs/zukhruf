import type { ChildProcess, Serializable } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

import type { Connection, ConnectionEvents } from '../remote/connection.ts';
import { unwrap, wrap } from '../remote/envelope.ts';
import {
  type LockResponse,
  type RequestEnvelope,
  isRequestEnvelope,
} from '../remote/protocol.ts';

/**
 * The parent's end of the IPC channel to one child. The kernel closes the
 * channel when the child dies, so `disconnect` reports even a SIGKILL.
 */
export class ChildProcessConnection
  extends EventEmitter<ConnectionEvents<RequestEnvelope>>
  implements Connection<LockResponse, RequestEnvelope>
{
  readonly #child: ChildProcess;
  /** A send after the channel closed reports the error through its callback. */
  readonly #send: (envelope: Serializable) => Promise<void>;

  readonly #onMessage = (envelope: unknown) => {
    const request = unwrap(envelope);
    if (isRequestEnvelope(request)) this.emit('message', request);
  };

  readonly #onDisconnect = () => {
    this.close();
    this.emit('close');
  };

  constructor(child: ChildProcess) {
    super();
    this.#child = child;
    this.#send = promisify<Serializable, void>(child.send).bind(child);
    child.on('message', this.#onMessage);
    child.once('disconnect', this.#onDisconnect);
  }

  send(response: LockResponse): Promise<void> {
    return this.#send(wrap(response));
  }

  /** The running child already keeps the parent alive. */
  ref() {}

  unref() {}

  close() {
    this.#child.off('message', this.#onMessage);
    this.#child.off('disconnect', this.#onDisconnect);
  }
}
