import { once } from 'node:events';
import { type Socket, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import type { LeaderElection, Term } from '@zukhruf/election';

import type { ClientConnection, ClientConnector } from '../remote/connector.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockResponse,
} from '../remote/protocol.ts';
import { AdvertisedOpsConnection } from './advertised-ops-connection.ts';
import { type Greeting, PROTOCOL_VERSION, greet } from './handshake.ts';
import { ProtocolVersionError } from './protocol-version-error.ts';
import { SocketConnection } from './socket-connection.ts';

/**
 * How long a leader may keep its term while it hangs up on every hello. One
 * that stops ends its term within moments; one from before the handshake keeps it.
 */
const HANDSHAKE_PATIENCE = 1000;

export interface ElectingConnectorOptions {
  socketPath: string;
  /** Only `campaign`: the connector never runs a backend's own steps, so an election of any backend fits. */
  election: Pick<LeaderElection<unknown>, 'campaign'>;
  pollInterval: number;
  /** Starts serving for a term this process just won. */
  serve(term: Term): Promise<void>;
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
    const { socketPath, pollInterval } = this.#options;
    for (;;) {
      const leader = await reachUnlessAborted(socketPath, signal);
      if (leader) {
        const connection =
          (await this.#follow(leader, signal)) ??
          (await this.#outlastHangUp(signal));
        if (connection) return connection;
      }
      const term = await this.#campaign(pollInterval, signal);
      if (term) {
        const own = await this.#lead(term, signal);
        if (own) return own;
      } else {
        await untilAborted(delay(pollInterval, undefined, { signal }), signal);
      }
    }
  }

  /**
   * After a leader hung up on the hello: a leader that stops frees its term
   * within moments, so this process leads or follows the successor soon
   * enough to reassert its keys in the successor's grace window. A leader from
   * before the handshake keeps its term and hangs up on every hello, which
   * fails the connect after HANDSHAKE_PATIENCE. Resolves `undefined` once
   * nothing listens.
   */
  async #outlastHangUp(
    signal: AbortSignal,
  ): Promise<ClientConnection | undefined> {
    const { socketPath, pollInterval } = this.#options;
    const deadline = performance.now() + HANDSHAKE_PATIENCE;
    for (;;) {
      const term = await this.#campaign(0, signal);
      if (term) return this.#lead(term, signal);
      const again = await reachUnlessAborted(socketPath, signal);
      if (!again) return undefined;
      const connection = await this.#follow(again, signal);
      if (connection) return connection;
      if (performance.now() >= deadline) {
        throw new ProtocolVersionError(PROTOCOL_VERSION, undefined);
      }
      await untilAborted(delay(pollInterval, undefined, { signal }), signal);
    }
  }

  /**
   * Campaigns until `timeout`; a term won after `signal` aborted is resigned.
   * The election gives up a term that it wins after the abort, but the abort
   * can also land after the campaign resolved, before this step continues.
   */
  async #campaign(
    timeout: number,
    signal: AbortSignal,
  ): Promise<Term | undefined> {
    const term = await this.#options.election.campaign({ timeout, signal });
    if (signal.aborted) await term?.resign();
    signal.throwIfAborted();
    return term;
  }

  /** Serves the term this process just won, and reaches its own server without following anyone. */
  async #lead(
    term: Term,
    signal: AbortSignal,
  ): Promise<ClientConnection | undefined> {
    await using serving = new AsyncDisposableStack();
    // A term that nothing serves would stop every other candidate from leading.
    serving.defer(() => term.resign());
    await this.#options.serve(term);
    serving.move();
    const own = await reachUnlessAborted(this.#options.socketPath, signal);
    if (!own) return undefined;
    const greeting = await greetUnlessAborted(own, signal);
    if (greeting.kind === 'welcome') return leaderConnection(own, greeting.ops);
    own.destroy();
    return undefined;
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
    using following = new DisposableStack();
    // Nobody will use this socket, and an open one would keep the process alive.
    following.defer(() => socket.destroy());
    this.#options.connected();
    following.move();
    return leaderConnection(socket, greeting.ops);
  }
}

function leaderConnection(
  socket: Socket,
  listed: ReadonlySet<string>,
): ClientConnection {
  return new AdvertisedOpsConnection(
    new SocketConnection<LockRequest, LockResponse>(socket, isLockResponse),
    listed,
  );
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
async function reach(socketPath: string): Promise<Socket | undefined> {
  const socket = connect(socketPath);
  try {
    await once(socket, 'connect');
    return socket;
  } catch {
    socket.destroy();
    return undefined;
  }
}

/** Greets the leader on `socket`; a store that closes meanwhile gives the socket up. */
async function greetUnlessAborted(
  socket: Socket,
  signal: AbortSignal,
): Promise<Greeting> {
  using greeting = new DisposableStack();
  greeting.defer(() => socket.destroy());
  const greeted = await untilAborted(greet(socket), signal);
  greeting.move();
  return greeted;
}
