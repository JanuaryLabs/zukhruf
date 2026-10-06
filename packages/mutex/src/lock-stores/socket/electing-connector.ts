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
  /** The connector only campaigns, so it needs only that part of an election. */
  election: Pick<LeaderElection, 'campaign'>;
  pollInterval: number;
  /** Starts serving for a term this process just won. */
  serve(leadership: Leadership): Promise<void>;
  /** Reached the server of another process, so this process follows it. */
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
      const leader = await reachUnlessAborted(socketPath, signal);
      if (leader) {
        try {
          connected();
        } catch (error) {
          // Nobody will use this socket, and an open one would keep the process alive.
          leader.destroy();
          throw error;
        }
        return new SocketConnection<LockRequest, LockResponse>(
          leader,
          isLockResponse,
        );
      }
      const leadership = await election.campaign({ timeout: pollInterval });
      if (signal.aborted) await leadership?.resign();
      signal.throwIfAborted();
      if (leadership) {
        try {
          await serve(leadership);
        } catch (error) {
          // A term that nothing serves would stop every other candidate from leading.
          await leadership.resign();
          throw error;
        }
        // This process leads now, so it reaches its own server without following anyone.
        const own = await reachUnlessAborted(socketPath, signal);
        if (own) {
          return new SocketConnection<LockRequest, LockResponse>(
            own,
            isLockResponse,
          );
        }
      } else {
        await delay(pollInterval, undefined, { signal });
      }
    }
  }
}

/** Like `reach`, but a socket reached after `signal` aborted is destroyed, not returned. */
async function reachUnlessAborted(
  socketPath: string,
  signal: AbortSignal,
): Promise<Socket | undefined> {
  signal.throwIfAborted();
  const socket = await reach(socketPath);
  if (signal.aborted) socket?.destroy();
  signal.throwIfAborted();
  return socket;
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
