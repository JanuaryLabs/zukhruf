import { type Socket, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';

import type { LeaderElection } from '../election/leader-election.ts';
import type { Leadership } from '../election/leadership.ts';
import {
  type FlightRequest,
  type FlightResponse,
  isFlightResponse,
} from '../protocol/flight-protocol.ts';
import type { FlightConnection, FlightConnector } from './connector.ts';
import { type Greeting, PROTOCOL_VERSION, greet } from './handshake.ts';
import { ProtocolVersionError } from './protocol-version-error.ts';
import { SocketConnection } from './socket-connection.ts';

/**
 * How long a coordinator may keep its term while it hangs up on every hello.
 * One that stops ends its term within moments.
 */
const HANDSHAKE_PATIENCE = 1000;

export interface ElectingConnectorOptions {
  socketPath: string;
  /** The connector only campaigns, so it needs only that part of an election. */
  election: Pick<LeaderElection, 'campaign'>;
  pollInterval: number;
  /** Starts serving for a term this process just won. */
  serve(leadership: Leadership): Promise<void>;
}

/**
 * Reaches the coordinator's socket, and when nobody serves it, campaigns to
 * become the coordinator. Never gives up: a lost coordinator is always
 * replaced by a candidate. An aborted connect never starts serving: a term
 * won after the abort is resigned.
 */
export class ElectingConnector implements FlightConnector {
  readonly #options: ElectingConnectorOptions;

  constructor(options: ElectingConnectorOptions) {
    this.#options = options;
  }

  async connect(signal: AbortSignal): Promise<FlightConnection> {
    const { socketPath, pollInterval } = this.#options;
    for (;;) {
      const coordinator = await reachUnlessAborted(socketPath, signal);
      if (coordinator) {
        const connection =
          (await this.#follow(coordinator, signal)) ??
          (await this.#outlastHangUp(signal));
        if (connection) return connection;
      }
      const leadership = await this.#campaign(pollInterval, signal);
      if (leadership) {
        const own = await this.#coordinate(leadership, signal);
        if (own) return own;
      } else {
        await delay(pollInterval, undefined, { signal });
      }
    }
  }

  /**
   * After a coordinator hung up on the hello: a coordinator that stops frees
   * its term within moments, so this process coordinates or reaches the
   * successor soon enough to reassert its flights in the successor's grace
   * window. A coordinator that keeps its term and hangs up on every hello
   * fails the connect after HANDSHAKE_PATIENCE. Resolves `undefined` once
   * nothing listens.
   */
  async #outlastHangUp(
    signal: AbortSignal,
  ): Promise<FlightConnection | undefined> {
    const { socketPath, pollInterval } = this.#options;
    const deadline = performance.now() + HANDSHAKE_PATIENCE;
    for (;;) {
      const leadership = await this.#campaign(0, signal);
      if (leadership) return this.#coordinate(leadership, signal);
      const again = await reachUnlessAborted(socketPath, signal);
      if (!again) return undefined;
      const connection = await this.#follow(again, signal);
      if (connection) return connection;
      if (performance.now() >= deadline) {
        throw new ProtocolVersionError(PROTOCOL_VERSION, undefined);
      }
      await delay(pollInterval, undefined, { signal });
    }
  }

  /** Campaigns until `timeout`; a term won after `signal` aborted is resigned. */
  async #campaign(
    timeout: number,
    signal: AbortSignal,
  ): Promise<Leadership | undefined> {
    const leadership = await this.#options.election.campaign({ timeout });
    if (signal.aborted) await leadership?.resign();
    signal.throwIfAborted();
    return leadership;
  }

  /** Serves the term this process just won, and reaches its own server like any other process. */
  async #coordinate(
    leadership: Leadership,
    signal: AbortSignal,
  ): Promise<FlightConnection | undefined> {
    try {
      await this.#options.serve(leadership);
    } catch (error) {
      // A term that nothing serves would stop every other candidate from coordinating.
      await leadership.resign();
      throw error;
    }
    const own = await reachUnlessAborted(this.#options.socketPath, signal);
    if (!own) return undefined;
    const greeting = await greetUnlessAborted(own, signal);
    if (greeting.kind === 'welcome') return flightConnection(own);
    own.destroy();
    return undefined;
  }

  /** Uses the coordinator on `socket` if it speaks this protocol; `undefined` when it hung up on the hello. */
  async #follow(
    socket: Socket,
    signal: AbortSignal,
  ): Promise<FlightConnection | undefined> {
    const greeting = await greetUnlessAborted(socket, signal);
    if (greeting.kind === 'welcome') return flightConnection(socket);
    socket.destroy();
    if (greeting.kind === 'refused') {
      throw new ProtocolVersionError(PROTOCOL_VERSION, greeting.version);
    }
    return undefined;
  }
}

function flightConnection(socket: Socket): FlightConnection {
  return new SocketConnection<FlightRequest, FlightResponse>(
    socket,
    isFlightResponse,
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

/** Resolves `undefined` when nothing listens yet (no file, or a dead coordinator's file). */
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

/** Greets the coordinator on `socket`; a client that closes meanwhile gives the socket up. */
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
