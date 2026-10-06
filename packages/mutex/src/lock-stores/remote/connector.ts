import type { Connection } from './connection.ts';
import type { LockRequest, LockResponse } from './protocol.ts';

export type ClientConnection = Connection<LockRequest, LockResponse>;

/** Decides how a client reaches its coordinator, and whether it can again after losing it. */
export interface Connector<Outgoing, Incoming> {
  /**
   * Resolves to `undefined` when the coordinator is gone for good and nothing
   * can replace it, so no other holder can ever be granted a key either.
   * Rejects when this attempt failed and a later one may succeed. Once
   * `signal` aborts, rejects with its reason and leaves nothing started.
   */
  connect(
    signal: AbortSignal,
  ): Promise<Connection<Outgoing, Incoming> | undefined>;
}

export type ClientConnector = Connector<LockRequest, LockResponse>;
