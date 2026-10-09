import { unlink } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';

import { isErrno } from '@zukhruf/fs';

import { EpochTokenSource } from '../../fencing/epoch-token-source.ts';
import type { Leadership } from '../../leader-election/leadership.ts';
import { LockCoordinator } from '../remote/lock-coordinator.ts';
import {
  type LockResponse,
  type RequestEnvelope,
  isRequestEnvelope,
} from '../remote/protocol.ts';
import { welcome } from './handshake.ts';
import { SocketConnection } from './socket-connection.ts';

export interface LockServerOptions {
  /** Milliseconds the new term grants nothing, so holders from the last term can reassert. */
  graceWindow: number;
}

/**
 * Serves a `LockCoordinator` on a Unix socket for one leadership term. Tokens
 * carry the term's epoch, so they outrank every token of earlier terms.
 */
export class LockServer {
  readonly #server: Server;
  readonly #connections: Set<Socket>;
  readonly #leadership: Leadership;

  private constructor(
    server: Server,
    connections: Set<Socket>,
    leadership: Leadership,
  ) {
    this.#server = server;
    this.#connections = connections;
    this.#leadership = leadership;
  }

  static async start(
    socketPath: string,
    leadership: Leadership,
    { graceWindow }: LockServerOptions,
  ): Promise<LockServer> {
    // Only the leader gets here, so removing a dead leader's socket file cannot race another server.
    // Windows removes a named pipe when its process stops, so there is no file to remove.
    if (process.platform !== 'win32') {
      await unlink(socketPath).catch((error: unknown) => {
        if (!isErrno(error, 'ENOENT')) throw error;
      });
    }
    const coordinator = new LockCoordinator({
      tokens: new EpochTokenSource(leadership.epoch),
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
        coordinator.serve(
          new SocketConnection<LockResponse, RequestEnvelope>(
            socket,
            isRequestEnvelope,
          ),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.unref();
    return new LockServer(server, connections, leadership);
  }

  /**
   * Hands leadership over. Dropping every connection tells followers to elect
   * a successor and reassert their keys during its grace window; `close` alone
   * would wait for followers that never disconnect on their own. The term ends
   * only after the socket is gone: in the other order, this close could remove
   * a successor's socket file.
   */
  async close() {
    const closed = new Promise<void>((resolve) =>
      this.#server.close(() => resolve()),
    );
    for (const socket of this.#connections) socket.destroy();
    await closed;
    await this.#leadership.resign();
  }
}
