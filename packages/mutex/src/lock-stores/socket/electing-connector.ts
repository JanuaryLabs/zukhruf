import { type Socket, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import type { LeaderElection } from '../../leader-election/leader-election.ts';
import type { Leadership } from '../../leader-election/leadership.ts';
import { untilAborted } from '../../shared/until-aborted.ts';
import type { ClientConnection, ClientConnector } from '../remote/connector.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockResponse,
} from '../remote/protocol.ts';
import { type Greeting, PROTOCOL_VERSION, greet } from './handshake.ts';
import { ProtocolVersionError } from './protocol-version-error.ts';
import { SocketConnection } from './socket-connection.ts';

/**
 * How long a leader that hung up on the hello may take to end its term. One
 * that stops ends it within moments; one from before the handshake keeps it.
 */
const HANDSHAKE_PATIENCE = 1000;

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
    const { socketPath, election, pollInterval, serve } = this.#options;
    for (;;) {
      const leader = await reachUnlessAborted(socketPath, signal);
      if (leader) {
        const connection = await this.#follow(leader, signal);
        if (connection) return connection;
      }
      const leadership = await election.campaign({
        timeout: leader ? HANDSHAKE_PATIENCE : pollInterval,
      });
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
          if ((await greetUnlessAborted(own, signal)).kind === 'welcome') {
            return new SocketConnection<LockRequest, LockResponse>(
              own,
              isLockResponse,
            );
          }
          own.destroy();
        }
      } else if (leader) {
        // The term is still held: either the leader that hung up predates the
        // handshake, or a successor took over while it stopped. Only the
        // successor answers a second hello.
        const again = await reachUnlessAborted(socketPath, signal);
        if (again) {
          const connection = await this.#follow(again, signal);
          if (connection) return connection;
          throw new ProtocolVersionError(PROTOCOL_VERSION, undefined);
        }
      } else {
        await delay(pollInterval, undefined, { signal });
      }
    }
  }

  /** Follows the leader on `socket` if it speaks this protocol; `undefined` when it hung up on the hello. */
  async #follow(
    socket: Socket,
    signal: AbortSignal,
  ): Promise<ClientConnection | undefined> {
    const greeting = await greetUnlessAborted(socket, signal);
    if (greeting.kind !== 'welcome') {
      socket.destroy();
      if (greeting.kind === 'refused') {
        throw new ProtocolVersionError(PROTOCOL_VERSION, greeting.version);
      }
      return undefined;
    }
    try {
      this.#options.connected();
    } catch (error) {
      // Nobody will use this socket, and an open one would keep the process alive.
      socket.destroy();
      throw error;
    }
    return new SocketConnection<LockRequest, LockResponse>(
      socket,
      isLockResponse,
    );
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

/** Greets the leader on `socket`; a store that closes meanwhile gives the socket up. */
async function greetUnlessAborted(
  socket: Socket,
  signal: AbortSignal,
): Promise<Greeting> {
  try {
    return await untilAborted(greet(socket), signal);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
