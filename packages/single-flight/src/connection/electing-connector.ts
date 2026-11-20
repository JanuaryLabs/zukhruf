import type { Socket } from 'node:net';

import { Backoff, type Clock, delay, untilAborted } from '@zukhruf/async';
import type { LeaderObserver, SqliteElection, Term } from '@zukhruf/election';
import { isErrno } from '@zukhruf/fs';
import type { PipeAddress } from '@zukhruf/pipes';

import type { FlightRequest } from '../protocol/flight-protocol.ts';
import type { FlightConnection, FlightConnector } from './connector.ts';
import { type Greeting, PROTOCOL_VERSION, greet } from './handshake.ts';
import { ProtocolVersionError } from './protocol-version-error.ts';
import { SocketConnection } from './socket-connection.ts';

export interface ElectingConnectorOptions {
  /** Where the coordinator listens. */
  address: PipeAddress;
  /** One try of the claim, and an observer of the coordinator (election ADR 0009). */
  election: Pick<SqliteElection, 'campaign' | 'observe'>;
  /** The clock of the back-off between two tries. */
  clock: Clock;
  /** Starts serving for a term this process just won. */
  serve(term: Term): Promise<void>;
}

/**
 * The wait after a lost try while the server of the new coordinator is not
 * reachable yet: the back-off of the election, etcd's first retry of 25 ms,
 * gRPC's multiplier of 1.6 and jitter of ±20 %, at most 1000 ms (election
 * ADR 0007).
 */
const backoff = new Backoff({
  initial: 25,
  multiplier: 1.6,
  max: 1000,
  jitter: { kind: 'ratio', ratio: 0.2 },
});

/**
 * Reaches the coordinator's socket, and when nobody serves it, campaigns to
 * become the coordinator. Never gives up: a lost coordinator is always
 * replaced by a candidate. A follower observes the coordinator, so a
 * coordinator that is silent past its lease duration is ended and replaced
 * too (election ADR 0009). An aborted connect never starts serving: a term
 * won after the abort is resigned.
 */
export class ElectingConnector implements FlightConnector {
  readonly #options: ElectingConnectorOptions;

  constructor(options: ElectingConnectorOptions) {
    this.#options = options;
  }

  async connect(signal: AbortSignal): Promise<FlightConnection> {
    const { address, election, clock } = this.#options;
    using betweenTries = new BetweenTries(election, clock);
    for (;;) {
      const coordinator = await reachUnlessAborted(address, signal);
      if (coordinator) {
        const connection =
          (await this.#follow(coordinator, signal)) ??
          (await this.#outlastHangUp(betweenTries, signal));
        if (connection) return connection;
      }
      const term = await this.#campaign(signal);
      if (term) {
        const own = await this.#coordinate(term, signal);
        if (own) return own;
      } else {
        await betweenTries.wait(signal);
      }
    }
  }

  /**
   * After a coordinator hung up on the hello: a coordinator that stops frees
   * its term within moments, so this process coordinates or reaches the
   * successor at once, and reasserts its flights. Resolves `undefined` once
   * nothing listens.
   */
  async #outlastHangUp(
    betweenTries: BetweenTries,
    signal: AbortSignal,
  ): Promise<FlightConnection | undefined> {
    for (;;) {
      const term = await this.#campaign(signal);
      if (term) return this.#coordinate(term, signal);
      const again = await reachUnlessAborted(this.#options.address, signal);
      if (!again) return undefined;
      const connection = await this.#follow(again, signal);
      if (connection) return connection;
      await betweenTries.wait(signal);
    }
  }

  /**
   * Tries the claim once; a term won after `signal` aborted is resigned.
   * The election gives up a term that it wins after the abort, but the abort
   * can also land after the campaign resolved, before this step continues.
   */
  async #campaign(signal: AbortSignal): Promise<Term | undefined> {
    const term = await this.#options.election.campaign({ signal });
    if (signal.aborted) await term?.resign();
    signal.throwIfAborted();
    return term;
  }

  /** Serves the term this process just won, and reaches its own server like any other process. */
  async #coordinate(
    term: Term,
    signal: AbortSignal,
  ): Promise<FlightConnection | undefined> {
    await using serving = new AsyncDisposableStack();
    // A term that nothing serves would stop every other candidate from coordinating.
    serving.defer(() => term.resign());
    await this.#options.serve(term);
    serving.move();
    const own = await reachUnlessAborted(this.#options.address, signal);
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
    const greeted = new AbortController();
    this.#observeCoordinator(socket, greeted.signal);
    const greeting = await greetUnlessAborted(socket, signal).finally(() =>
      greeted.abort(),
    );
    if (greeting.kind === 'welcome') return flightConnection(socket);
    socket.destroy();
    if (greeting.kind === 'refused') {
      throw new ProtocolVersionError(PROTOCOL_VERSION, greeting.version);
    }
    return undefined;
  }

  /**
   * Observes the coordinator until `socket` closes, so a coordinator that
   * goes silent is ended (election ADR 0009). A coordinator that leaves
   * before `greeted` aborts takes `socket` with it, as a hang-up does. After
   * the welcome, the kernel closes `socket` when the process of the
   * coordinator ends, and the supervisor reconnects as after each death of a
   * coordinator. A coordinator that this process cannot observe, such as one
   * of a published version, which serves no pipe, is followed as before:
   * nothing can take its place while it lives.
   */
  #observeCoordinator(socket: Socket, greeted: AbortSignal): void {
    const observer = this.#options.election.observe();
    socket.once('close', () => observer[Symbol.dispose]());
    observer.left.then(
      (reason) => {
        if (reason !== 'absent' && !greeted.aborted) socket.destroy();
      },
      // An observer that fails leaves the coordinator as one that serves no pipe is: followed.
      () => {},
    );
  }
}

/**
 * The wait after a lost try, while the server of the new coordinator is not
 * reachable yet: the first of the coordinator's leave and the next step of
 * the back-off (election ADR 0009). One observer lasts across the steps
 * until it settles, so it also ends a coordinator that hung before its
 * server listened.
 */
class BetweenTries implements Disposable {
  readonly #election: Pick<SqliteElection, 'observe'>;
  readonly #clock: Clock;
  #watch: Unwatched | Watching = new Unwatched();
  #retries = 0;

  constructor(election: Pick<SqliteElection, 'observe'>, clock: Clock) {
    this.#election = election;
    this.#clock = clock;
  }

  /** Rejects with `signal.reason`, or with an error of the observer. */
  async wait(signal: AbortSignal): Promise<void> {
    const watching = (this.#watch = this.#watch.watch(this.#election));
    const stepped = new AbortController();
    const step = delay(backoff.duration(this.#retries++), {
      clock: this.#clock,
      signal: AbortSignal.any([signal, stepped.signal]),
    });
    const left = watching.observer.left.then((reason) => {
      this.#settled(watching);
      // No pipe to watch: a new coordinator is starting, so only the step can tell.
      if (reason === 'absent') return step;
      this.#retries = 0;
    });
    try {
      await Promise.race([step, left]);
    } finally {
      stepped.abort();
    }
  }

  /** The next wait observes again. */
  #settled(watching: Watching): void {
    if (this.#watch !== watching) return;
    watching[Symbol.dispose]();
    this.#watch = new Unwatched();
  }

  [Symbol.dispose](): void {
    this.#watch[Symbol.dispose]();
  }
}

/** No observer: before the first wait of a connect, and after an observer settled. */
class Unwatched implements Disposable {
  watch(election: Pick<SqliteElection, 'observe'>): Watching {
    return new Watching(election.observe());
  }

  [Symbol.dispose](): void {}
}

/** An observer that has not settled yet. */
class Watching implements Disposable {
  readonly observer: LeaderObserver;

  constructor(observer: LeaderObserver) {
    this.observer = observer;
  }

  watch(): Watching {
    return this;
  }

  [Symbol.dispose](): void {
    this.observer[Symbol.dispose]();
  }
}

function flightConnection(socket: Socket): FlightConnection {
  return new SocketConnection<FlightRequest>(socket);
}

/** Like `reach`, but a socket reached after `signal` aborted is destroyed, not returned. */
async function reachUnlessAborted(
  address: PipeAddress,
  signal: AbortSignal,
): Promise<Socket | undefined> {
  signal.throwIfAborted();
  const socket = await reach(address);
  if (signal.aborted) socket?.destroy();
  signal.throwIfAborted();
  return socket;
}

/**
 * Resolves `undefined` when nothing answers yet: no file (ENOENT), a dead
 * coordinator's file (ECONNREFUSED), something else at the path (ENOTSOCK on
 * macOS), which the campaign's own listen then reports, or a full backlog
 * (EAGAIN on Linux), after which the lost campaign waits and reaches again.
 */
async function reach(address: PipeAddress): Promise<Socket | undefined> {
  try {
    return await address.connect();
  } catch (error) {
    if (
      isErrno(error, 'ENOENT') ||
      isErrno(error, 'ECONNREFUSED') ||
      isErrno(error, 'ENOTSOCK') ||
      isErrno(error, 'EAGAIN')
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Greets the coordinator on `socket`; a client that closes meanwhile gives the socket up. */
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
