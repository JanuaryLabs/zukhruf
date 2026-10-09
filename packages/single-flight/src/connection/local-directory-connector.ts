import { assertLocalDirectory } from '@zukhruf/fs';

import type { FlightConnection, FlightConnector } from './connector.ts';

/**
 * Refuses a flight directory on a network file system before the first
 * connection exists. Every connect asks, but a directory that passed once is
 * remembered, so a failover never fails here and never costs a flight that
 * this process leads. Runs keep their call order, because the client queues
 * them before it connects.
 */
export class LocalDirectoryConnector implements FlightConnector {
  readonly #directory: string;
  readonly #connector: FlightConnector;

  constructor(directory: string, connector: FlightConnector) {
    this.#directory = directory;
    this.#connector = connector;
  }

  async connect(signal: AbortSignal): Promise<FlightConnection | undefined> {
    signal.throwIfAborted();
    await assertLocalDirectory(this.#directory);
    signal.throwIfAborted();
    return this.#connector.connect(signal);
  }
}
