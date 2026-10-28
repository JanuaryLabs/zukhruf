import { addAbortListener, once } from 'node:events';
import { rm } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';

import type { Term } from '@zukhruf/election';
import { EpochTokenSource } from '@zukhruf/fencing';

import { welcome } from '../connection/handshake.ts';
import { SocketConnection } from '../connection/socket-connection.ts';
import type { KeyLocks } from '../key-lock/key-locks.ts';
import type { FlightResponse } from '../protocol/flight-protocol.ts';
import { FlightCoordinator } from './flight-coordinator.ts';

export interface FlightServerOptions {
  /** The kernel locks on the keys, which the coordinator checks before a run leads. */
  locks: KeyLocks;
}

/**
 * Serves a `FlightCoordinator` on a Unix socket for one term. Lease tokens
 * carry the term's epoch, so they outrank every token of earlier terms. A
 * term that is lost may already be another process's, so the server closes
 * itself when the term's signal aborts.
 */
export class FlightServer {
  readonly #server: Server;
  readonly #connections: Set<Socket>;
  readonly #coordinator: FlightCoordinator;
  readonly #term: Term;
  readonly #closeOnLoss: Disposable;

  private constructor(
    server: Server,
    connections: Set<Socket>,
    coordinator: FlightCoordinator,
    term: Term,
  ) {
    this.#server = server;
    this.#connections = connections;
    this.#coordinator = coordinator;
    this.#term = term;
    this.#closeOnLoss = addAbortListener(term.signal, () => void this.close());
  }

  static async start(
    socketPath: string,
    term: Term,
    { locks }: FlightServerOptions,
  ): Promise<FlightServer> {
    // Only the coordinator gets here, so removing a dead coordinator's socket file cannot race another server.
    // Windows removes a named pipe when its process stops, so there is no file to remove.
    if (process.platform !== 'win32') {
      await rm(socketPath, { force: true });
    }
    const coordinator = new FlightCoordinator({
      tokens: new EpochTokenSource(term.epoch),
      locks,
      // Only a new term has tokens again, so the coordinator steps down. Its
      // clients then connect again, and the next term's coordinator answers
      // their runs. The coordinator mints only for a connection that
      // `started` serves.
      onTokensExhausted: () => void started.close(),
    });
    const connections = new Set<Socket>();
    // Serving others never keeps the coordinator alive: when its own work ends, it exits and another process takes over.
    const server = createServer((socket) => {
      socket.unref();
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      // Only a process that speaks this protocol is served, so this coordinator never reads a message it would misread.
      void welcome(socket).then((speaksOurs) => {
        if (!speaksOurs) return;
        coordinator.serve(new SocketConnection<FlightResponse>(socket));
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    server.unref();
    const started = new FlightServer(server, connections, coordinator, term);
    // The term may have been lost while the server started.
    if (term.signal.aborted) {
      await started.close();
      term.signal.throwIfAborted();
    }
    return started;
  }

  /**
   * Hands the term over. Ending every connection tells the other processes to
   * elect a successor and reassert their flights to it; `close` alone would
   * wait for clients that never disconnect on their own.
   * Each connection ends only after what was written to it, such as an
   * outcome for a joiner, is sent. The term ends only after the socket is
   * gone: in the other order, this close could remove a successor's socket file.
   * The first call removes the file at once, so a second caller finds it gone,
   * and it too resolves only once the term ended as the first call ended it.
   * The coordinator stops watching the locks of the keys whose runs wait.
   */
  async close() {
    this.#closeOnLoss[Symbol.dispose]();
    this.#coordinator.close();
    const closed = this.#server[Symbol.asyncDispose]();
    for (const socket of this.#connections) socket.destroySoon();
    await closed;
    await this.#term.resign();
  }
}
