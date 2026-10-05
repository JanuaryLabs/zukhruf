import type { Worker } from 'node:worker_threads';

import type { Connection, ConnectionHandlers } from '../remote/connection.ts';
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
export class WorkerConnection implements Connection<LockResponse, LockRequest> {
  readonly #worker: Worker;
  #exited = false;
  #detach = () => {};

  constructor(worker: Worker) {
    this.#worker = worker;
  }

  async send(response: LockResponse): Promise<void> {
    if (this.#exited) throw new Error('The worker thread has exited.');
    this.#worker.postMessage(wrap(response));
  }

  listen({ message, close }: ConnectionHandlers<LockRequest>) {
    const onMessage = (envelope: unknown) => {
      const request = unwrap(envelope);
      if (isLockRequest(request)) message(request);
    };
    const onExit = () => {
      this.#exited = true;
      this.close();
      close();
    };
    this.#worker.on('message', onMessage);
    this.#worker.once('exit', onExit);
    this.#detach = () => {
      this.#worker.off('message', onMessage);
      this.#worker.off('exit', onExit);
    };
  }

  /** The running worker already keeps its starting thread alive. */
  ref() {}

  unref() {}

  close() {
    this.#detach();
  }
}
