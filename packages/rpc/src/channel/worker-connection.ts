import type { Worker } from 'node:worker_threads';

import { ConnectionClosedError } from '../connection/connection-closed-error.ts';
import type { ChannelOptions } from './envelope.ts';
import { SharedChannelConnection } from './shared-channel-connection.ts';

/**
 * The starting thread's end of the message port to one worker thread.
 * `Worker` emits `exit` however the thread stops, so a terminated or crashed
 * thread is always noticed.
 */
export class WorkerConnection<
  Outgoing,
> extends SharedChannelConnection<Outgoing> {
  readonly #worker: Worker;

  constructor(worker: Worker, options: ChannelOptions) {
    super(worker, ['exit'], options);
    this.#worker = worker;
    this.listen();
  }

  async send(message: Outgoing): Promise<void> {
    // A stopped worker drops messages without an error; its thread id is -1 from then on.
    if (this.#worker.threadId === -1) {
      throw new ConnectionClosedError({
        cause: new Error('The worker thread has exited.'),
      });
    }
    this.#worker.postMessage(this.envelope.wrap(message));
  }

  /** The running worker already keeps its starting thread alive. */
  ref() {}

  unref() {}

  async close() {
    this.stopListening();
  }
}
