import { addAbortListener } from 'node:events';
import type { Socket } from 'node:net';

import { type Clock, delay } from '@zukhruf/async';
import type { Term } from '@zukhruf/election';
import { EpochTokenSource } from '@zukhruf/fencing';
import type { PipeEndpoint, PipeServer } from '@zukhruf/pipes';

import { LockCoordinator } from '../remote/lock-coordinator.ts';
import type { LockResponse } from '../remote/protocol.ts';
import { backoff } from './backoff.ts';
import { welcome } from './handshake.ts';
import type { SessionDirectory } from './session-directory.ts';
import { SocketConnection } from './socket-connection.ts';

/**
 * The recovery of a term after a failover (ADR 0033): the new leader waits
 * for each session recorded in `sessions`. `own` is the session of this
 * process, which lives, and `clock` runs the deadlines and the checks.
 */
export interface LockServerRecovery {
  sessions: SessionDirectory;
  own: string;
  clock: Clock;
}

export interface LockServerOptions {
  /** `undefined` when no earlier term can have left a holder: the first term of a directory, or a term after a clean shutdown. */
  recovery: LockServerRecovery | undefined;
}

/**
 * Serves a `LockCoordinator` on a Unix socket for one leadership term. Tokens
 * carry the term's epoch, so they outrank every token of earlier terms. A
 * term that is lost may already be another process's, so the server closes
 * itself when the term's signal aborts.
 */
export class LockServer {
  readonly #server: PipeServer;
  readonly #connections: Set<Socket>;
  readonly #coordinator: LockCoordinator;
  readonly #term: Term;
  readonly #recovery: LockServerRecovery | undefined;
  readonly #closing = new AbortController();
  readonly #closeOnLoss: Disposable;

  private constructor(
    server: PipeServer,
    connections: Set<Socket>,
    coordinator: LockCoordinator,
    term: Term,
    recovery: LockServerRecovery | undefined,
  ) {
    this.#server = server;
    this.#connections = connections;
    this.#coordinator = coordinator;
    this.#term = term;
    this.#recovery = recovery;
    this.#closeOnLoss = addAbortListener(term.signal, () => void this.close());
  }

  /**
   * Before it listens, a server that recovers lists the recorded sessions and
   * deletes those that stopped. The deadlines of the others count from the
   * listen, so each session gets its lease duration after the failover.
   */
  static async start(
    endpoint: PipeEndpoint,
    term: Term,
    { recovery }: LockServerOptions,
  ): Promise<LockServer> {
    const recovering = await recovery?.sessions.recover(recovery.own);
    const listening = Promise.withResolvers<LockServer>();
    const connections = new Set<Socket>();
    // Only the leader gets here, so the listen that removes a dead leader's socket file cannot race another server.
    // Serving others never keeps the leader alive: when its own work ends, it exits and another process takes over.
    const server = await endpoint.listen((socket) => {
      socket.unref();
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      // Only a process that speaks this protocol is served, so this coordinator never reads a message it would misread.
      void Promise.all([welcome(socket), listening.promise]).then(
        ([session, started]) => {
          if (session !== undefined) started.#serve(socket, session);
        },
      );
    });
    server.unref();
    const coordinator = new LockCoordinator({
      tokens: new EpochTokenSource(term.epoch),
      recovery: recovering && { sessions: recovering, clock: recovery!.clock },
      // Only a new term has tokens again, so the leader steps down. Its
      // followers then reconnect, and a new term grants their requests. The
      // coordinator mints only for a connection that `started` serves.
      onTokensExhausted: () => void started.close(),
    });
    const started = new LockServer(
      server,
      connections,
      coordinator,
      term,
      recovery,
    );
    listening.resolve(started);
    void started.#checkPresences();
    // The term may have been lost while the server started.
    if (term.signal.aborted) {
      await started.close();
      term.signal.throwIfAborted();
    }
    return started;
  }

  /** A connection of a recovering session that closes before its marker may be the end of its process. */
  #serve(socket: Socket, session: string) {
    this.#coordinator.serve(
      new SocketConnection<LockResponse>(socket),
      session,
    );
    socket.once('close', () => {
      if (this.#coordinator.recovering.has(session)) void this.#check(session);
    });
  }

  /**
   * Checks the presence of each recovering session at each step of the
   * back-off, until the recovery is over. The kernel tells nobody when a
   * presence frees, so the server asks again.
   */
  async #checkPresences() {
    for (let step = 0; this.#coordinator.recovering.size > 0; step++) {
      try {
        await delay(backoff.duration(step), {
          clock: this.#recovery!.clock,
          signal: this.#closing.signal,
          ref: false,
        });
      } catch (error) {
        if (this.#closing.signal.aborted) return;
        throw error;
      }
      for (const session of this.#coordinator.recovering) {
        await this.#check(session);
      }
    }
  }

  /**
   * Ends the recovery of `session` when its presence is free. A check that
   * fails ends this term: the next leader recovers the same sessions.
   */
  async #check(session: string) {
    const { sessions, own } = this.#recovery!;
    if (session === own) return;
    try {
      if (await sessions.endIfStopped(session)) {
        this.#coordinator.ended(session);
      }
    } catch (error) {
      process.emitWarning(
        Object.assign(
          new Error(
            `The recovery check of a session failed, and the server ends its term: ${Error.isError(error) ? error.message : String(error)}`,
            { cause: error },
          ),
          {
            name: 'LockServerWarning',
            code: 'ZUKHRUF_MUTEX_LOCK_SERVER_RECOVERY_CHECK_FAILED',
            detail: `session: ${session}`,
          },
        ),
      );
      await this.close();
    }
  }

  /**
   * Hands leadership over. Dropping every connection tells followers to elect
   * a successor and reassert their keys during its recovery; `close` alone
   * would wait for followers that never disconnect on their own. The term ends
   * only after the socket is gone: in the other order, this close could remove
   * a successor's socket file. The term resigns clean when the coordinator
   * leaves nothing to recover, so the successor has no recovery; a lost
   * term records nothing. The first call removes the file at once, so a second
   * caller finds it gone, and it too resolves only once the term ended as the
   * first call ended it.
   */
  async close() {
    this.#closeOnLoss[Symbol.dispose]();
    this.#closing.abort();
    const closed = this.#server.close();
    // Read in the step that drops the connections: each session that ends
    // releases its keys, so later no key is ever held. A grant written after
    // this step never reaches its process, which asks the successor again.
    const clean = this.#coordinator.leavesNothingToRecover;
    for (const socket of this.#connections) socket.destroy();
    await closed;
    await this.#term.resign({ clean });
  }
}
