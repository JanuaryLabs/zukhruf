import type { Connection } from './connection.ts';

/** Decides how a client reaches its peer, and whether it can again after losing it. */
export interface Connector<Outgoing> {
  /**
   * Resolves to `undefined` when the peer is gone for good and nothing can
   * replace it. Rejects when this attempt failed and a later one may succeed.
   * Once `signal` aborts, rejects with its reason and leaves nothing started.
   */
  connect(signal: AbortSignal): Promise<Connection<Outgoing> | undefined>;
}
