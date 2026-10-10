import { addAbortListener, once } from 'node:events';
import { rm } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';

import type { Term } from '@zukhruf/election';
import { EpochTokenSource } from '@zukhruf/fencing';

import { LockCoordinator } from '../remote/lock-coordinator.ts';
import type { LockResponse } from '../remote/protocol.ts';
import { welcome } from './handshake.ts';
import { SocketConnection } from './socket-connection.ts';

export interface LockServerOptions {
  /** Milliseconds the new term grants nothing, so holders from the last term can reassert. */
  graceWindow: number;
}

/**
 * Serves a `LockCoordinator` on a Unix socket for one leadership term. Tokens
 * carry the term's epoch, so they outrank every token of earlier terms. A
 * term that is lost may already be another process's, so the server closes
 * itself when the term's signal aborts.
 */
export class LockServer {
  readonly #server: Server;
  readonly #connections: Set<Socket>;
  readonly #term: Term;
  readonly #closeOnLoss: Disposable;

  private constructor(server: Server, connections: Set<Socket>, term: Term) {
    this.#server = server;
    this.#connections = connections;
    this.#term = term;
    this.#closeOnLoss = addAbortListener(term.signal, () => void this.close());
  }

  static async start(
    socketPath: string,
    term: Term,
    { graceWindow }: LockServerOptions,
  ): Promise<LockServer> {
    // Only the leader gets here, so removing a dead leader's socket file cannot race another server.
    // Windows removes a named pipe when its process stops, so there is no file to remove.
    if (process.platform !== 'win32') {
      await rm(socketPath, { force: true });
    }
    const coordinator = new LockCoordinator({
      tokens: new EpochTokenSource(term.epoch),
      graceWindow,
    });
    const connections = new Set<Socket>();
    // Serving others never keeps the leader alive: when its own work ends, it exits and another process takes over.
    const server = createServer((socket) => {
      socket.unref();
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      // Only a process that speaks this protocol is served, so this coordinator never reads a message it would misread.
      void welcome(socket).then((speaksOurs) => {
        if (!speaksOurs) return;
        coordinator.serve(new SocketConnection<LockResponse>(socket));
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    server.unref();
    const started = new LockServer(server, connections, term);
    // The term may have been lost while the server started.
    if (term.signal.aborted) {
      await started.close();
      term.signal.throwIfAborted();
    }
    return started;
  }

  /**
   * Hands leadership over. Dropping every connection tells followers to elect
   * a successor and reassert their keys during its grace window; `close` alone
   * would wait for followers that never disconnect on their own. The term ends
   * only after the socket is gone: in the other order, this close could remove
   * a successor's socket file. The first call removes the file at once, so a
   * second caller finds it gone, and it too resolves only once the term ended.
   */
  async close() {
    this.#closeOnLoss[Symbol.dispose]();
    const closed = this.#server[Symbol.asyncDispose]();
    for (const socket of this.#connections) socket.destroy();
    await closed;
    await this.#term.resign();
  }
}
