import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import type { Connection, ConnectionEvents } from '../remote/connection.ts';
import { unwrap, wrap } from '../remote/envelope.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockRequest,
} from '../remote/protocol.ts';

/**
 * The coordinator's end of the message port to one worker thread. `Worker`
 * emits `exit` however the thread stops, so a terminated or crashed holder
 * is always noticed.
 */
export class WorkerConnection
  extends EventEmitter<ConnectionEvents<LockRequest>>
  implements Connection<LockResponse, LockRequest>
{
  readonly #worker: Worker;

  readonly #onMessage = (envelope: unknown) => {
    const request = unwrap(envelope);
    if (isLockRequest(request)) this.emit('message', request);
  };

  readonly #onExit = () => {
    this.close();
    this.emit('close');
  };

  constructor(worker: Worker) {
    super();
    this.#worker = worker;
    worker.on('message', this.#onMessage);
    worker.once('exit', this.#onExit);
  }

  async send(response: LockResponse): Promise<void> {
    // A stopped worker drops messages without an error; its thread id is -1 from then on.
    if (this.#worker.threadId === -1) {
      throw new Error('The worker thread has exited.');
    }
    this.#worker.postMessage(wrap(response));
  }

  /** The running worker already keeps its starting thread alive. */
  ref() {}

  unref() {}

  close() {
    this.#worker.off('message', this.#onMessage);
    this.#worker.off('exit', this.#onExit);
  }
}
