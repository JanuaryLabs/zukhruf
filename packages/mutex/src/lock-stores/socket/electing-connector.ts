import { type Socket, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import type { LeaderElection } from '../../leader-election/leader-election.ts';
import type { Leadership } from '../../leader-election/leadership.ts';
import type { ClientConnection, ClientConnector } from '../remote/connector.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockResponse,
} from '../remote/protocol.ts';
import { SocketConnection } from './socket-connection.ts';

export interface ElectingConnectorOptions {
  socketPath: string;
  election: LeaderElection;
  pollInterval: number;
  /** Starts serving for a term this process just won. */
  serve(leadership: Leadership): Promise<void>;
  connected(): void;
}

/**
 * Reaches the leader's socket, and when nobody serves it, campaigns to become
 * the leader. Never gives up: a lost leader is always replaced by a candidate.
 * An aborted connect never starts serving: a term won after the abort is resigned.
 */
export class ElectingConnector implements ClientConnector {
  readonly #options: ElectingConnectorOptions;

  constructor(options: ElectingConnectorOptions) {
    this.#options = options;
  }

  async connect(signal: AbortSignal): Promise<ClientConnection> {
    const { socketPath, election, pollInterval, serve, connected } =
      this.#options;
    for (;;) {
      signal.throwIfAborted();
      const socket = await reach(socketPath);
      if (signal.aborted) socket?.destroy();
      signal.throwIfAborted();
      if (socket) {
        connected();
        return new SocketConnection<LockRequest, LockResponse>(
          socket,
          isLockResponse,
        );
      }
      const leadership = await election.campaign({ timeout: pollInterval });
      if (signal.aborted) await leadership?.resign();
      signal.throwIfAborted();
      if (leadership) await serve(leadership);
      else await delay(pollInterval, undefined, { signal });
    }
  }
}

/** Resolves `undefined` when nothing listens yet (no file, or a dead leader's file). */
function reach(socketPath: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const fail = () => {
      socket.destroy();
      resolve(undefined);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.off('error', fail);
      resolve(socket);
    });
  });
}
