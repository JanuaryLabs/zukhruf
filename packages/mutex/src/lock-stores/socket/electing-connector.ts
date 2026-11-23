import type { Socket } from 'node:net';

import { type Clock, delay, untilAborted } from '@zukhruf/async';
import type { LeaderObserver, SqliteElection, Term } from '@zukhruf/election';
import { isErrno } from '@zukhruf/fs';
import { NoServerError, type PipeAddress } from '@zukhruf/pipes';

import type { ClientConnection, ClientConnector } from '../remote/connector.ts';
import type { LockRequest } from '../remote/protocol.ts';
import { backoff } from './backoff.ts';
import { type Greeting, PROTOCOL_VERSION, greet } from './handshake.ts';
import { OwnServerConnection } from './own-server-connection.ts';
import { ProtocolVersionError } from './protocol-version-error.ts';
import { SocketConnection } from './socket-connection.ts';

export interface ElectingConnectorOptions {
  /** Where the leader listens. */
  address: PipeAddress;
  /** One try of the claim, and an observer of the leader (election ADR 0009). */
  election: Pick<SqliteElection, 'campaign' | 'observe'>;
  /** The clock of the back-off between two tries. */
  clock: Clock;
  /** The id of the session of this store, which each `hello` says (ADR 0033). */
  session: string;
  /** Starts serving for a term this process just won. */
  serve(term: Term): Promise<void>;
  /** Reached the server of another process, so this process follows it. */
  connected(): void;
}

/**
 * Reaches the leader's socket, and when nobody serves it, campaigns to become
 * the leader. Never gives up: a lost leader is always replaced by a candidate.
 * A follower observes the leader, so a leader that is silent past its lease
 * duration is ended and replaced too (election ADR 0009). An aborted connect
 * never starts serving: a term won after the abort is resigned.
 */
export class ElectingConnector implements ClientConnector {
  readonly #options: ElectingConnectorOptions;

  constructor(options: ElectingConnectorOptions) {
    this.#options = options;
  }

  async connect(signal: AbortSignal): Promise<ClientConnection> {
    const { address, election, clock } = this.#options;
    using betweenTries = new BetweenTries(election, clock);
    for (;;) {
      const leader = await reachUnlessAborted(address, signal);
      if (leader) {
        const connection =
          (await this.#follow(leader, signal)) ??
          (await this.#outlastHangUp(betweenTries, signal));
        if (connection) return connection;
      }
      const term = await this.#campaign(signal);
      if (term) {
        const own = await this.#lead(term, signal);
        if (own) return own;
      } else {
        await betweenTries.wait(signal);
      }
    }
  }

  /**
   * After a leader hung up on the hello: a leader that stops frees its term
   * within moments, so this process leads or follows the successor soon. A
   * campaign that waits for the term would wait for nothing when the
   * successor already leads, and the successor's recovery waits for this
   * session. Resolves `undefined` once nothing listens.
   */
  async #outlastHangUp(
    betweenTries: BetweenTries,
    signal: AbortSignal,
  ): Promise<ClientConnection | undefined> {
    for (;;) {
      const term = await this.#campaign(signal);
      if (term) return this.#lead(term, signal);
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
    const own = await reachUnlessAborted(this.#options.address, signal);
    if (!own) return undefined;
    const greeting = await greetUnlessAborted(
      own,
      this.#options.session,
      signal,
    );
    if (greeting.kind === 'welcome') {
      return new OwnServerConnection<LockRequest>(own);
    }
    own.destroy();
    return undefined;
  }

  /** Follows the leader on `socket` if it speaks this protocol; `undefined` when it hung up on the hello. */
  async #follow(
    socket: Socket,
    signal: AbortSignal,
  ): Promise<ClientConnection | undefined> {
    const greeted = new AbortController();
    this.#observeLeader(socket, greeted.signal);
    const greeting = await greetUnlessAborted(
      socket,
      this.#options.session,
      signal,
    ).finally(() => greeted.abort());
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
    return new SocketConnection<LockRequest>(socket);
  }

  /**
   * Observes the leader until `socket` closes, so a leader that goes silent
   * is ended (election ADR 0009). A leader that leaves before `greeted`
   * aborts takes `socket` with it, as a hang-up does. After the welcome, the
   * kernel closes `socket` when the process of the leader ends, and the
   * supervisor reconnects as after each death of a leader. A leader that
   * this process cannot observe, such as one of a published version, which
   * serves no pipe, is followed as before: nothing can take its place while
   * it lives.
   */
  #observeLeader(socket: Socket, greeted: AbortSignal): void {
    const observer = this.#options.election.observe();
    socket.once('close', () => observer[Symbol.dispose]());
    observer.left.then(
      (reason) => {
        if (reason !== 'absent' && !greeted.aborted) socket.destroy();
      },
      // An observer that fails leaves the leader as one that serves no pipe is: followed.
      () => {},
    );
  }
}

/**
 * The wait after a lost try, while the server of the new leader is not
 * reachable yet: the first of the leader's leave and the next step of the
 * back-off (election ADR 0009). One observer lasts across the steps until it
 * settles, so it also ends a leader that hung before its server listened.
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
      // No pipe to watch: a new leader is starting, so only the step can tell.
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
 * Resolves `undefined` when nothing answers yet: no server listens on the
 * path (`NoServerError` of @zukhruf/pipes; something else at the path is
 * then reported by the campaign's own listen), or a full backlog (EAGAIN on
 * Linux), after which the lost campaign waits and reaches again.
 */
async function reach(address: PipeAddress): Promise<Socket | undefined> {
  try {
    return await address.connect();
  } catch (error) {
    if (error instanceof NoServerError || isErrno(error, 'EAGAIN')) {
      return undefined;
    }
    throw error;
  }
}

/** Greets the leader on `socket`; a store that closes meanwhile gives the socket up. */
async function greetUnlessAborted(
  socket: Socket,
  session: string,
  signal: AbortSignal,
): Promise<Greeting> {
  using greeting = new DisposableStack();
  greeting.defer(() => socket.destroy());
  const greeted = await untilAborted(greet(socket, session), signal);
  greeting.move();
  return greeted;
}
