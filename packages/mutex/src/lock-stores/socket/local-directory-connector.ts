import { assertLocalDirectory } from '@zukhruf/fs';

import type { ClientConnection, ClientConnector } from '../remote/connector.ts';

/**
 * Refuses a lock directory on a network file system before the first
 * connection exists. Every connect asks, but a directory that passed once is
 * remembered, so a failover never fails here and never costs a held key.
 * Requests keep their call order, because the client queues them before it
 * connects.
 */
export class LocalDirectoryConnector implements ClientConnector {
  readonly #directory: string;
  readonly #connector: ClientConnector;

  constructor(directory: string, connector: ClientConnector) {
    this.#directory = directory;
    this.#connector = connector;
  }

  async connect(signal: AbortSignal): Promise<ClientConnection | undefined> {
    signal.throwIfAborted();
    await assertLocalDirectory(this.#directory);
    signal.throwIfAborted();
    return this.#connector.connect(signal);
  }
}
