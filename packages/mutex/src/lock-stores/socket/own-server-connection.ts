import { SocketConnection } from './socket-connection.ts';

/**
 * The connection of a leader to the lock server that it runs. A close waits
 * until the server read every request sent before, such as the release of
 * the last key. So when the store of the leader disposes, its lock server
 * sees only the keys that are really held, and it can resign its term clean.
 */
export class OwnServerConnection<Outgoing> extends SocketConnection<Outgoing> {
  override close(): Promise<void> {
    return this.end();
  }
}
