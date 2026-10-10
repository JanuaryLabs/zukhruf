import type { Worker } from 'node:worker_threads';

import { wrap } from '../remote/envelope.ts';
import type { LockResponse } from '../remote/protocol.ts';
import { SharedChannelConnection } from '../remote/shared-channel-connection.ts';

/**
 * The coordinator's end of the message port to one worker thread. `Worker`
 * emits `exit` however the thread stops, so a terminated or crashed holder
 * is always noticed.
 */
export class WorkerConnection extends SharedChannelConnection<LockResponse> {
  readonly #worker: Worker;

  constructor(worker: Worker) {
    super(worker, ['exit']);
    this.#worker = worker;
    this.listen();
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
    this.stopListening();
  }
}
