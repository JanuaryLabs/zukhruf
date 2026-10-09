import { unlink } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';

import { EpochTokenSource } from '@zukhruf/fencing';
import { isErrno } from '@zukhruf/fs';

import { welcome } from '../connection/handshake.ts';
import { SocketConnection } from '../connection/socket-connection.ts';
import type { Leadership } from '../election/leadership.ts';
import {
  type FlightResponse,
  type RequestEnvelope,
  isRequestEnvelope,
} from '../protocol/flight-protocol.ts';
import { FlightCoordinator } from './flight-coordinator.ts';

export interface FlightServerOptions {
  /** Milliseconds the new term starts no flight, so leaders from the last term can reassert theirs. */
  graceWindow: number;
}

/**
 * Serves a `FlightCoordinator` on a Unix socket for one term. Lease tokens
 * carry the term's epoch, so they outrank every token of earlier terms.
 */
export class FlightServer {
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
    { graceWindow }: FlightServerOptions,
  ): Promise<FlightServer> {
    // Only the coordinator gets here, so removing a dead coordinator's socket file cannot race another server.
    // Windows removes a named pipe when its process stops, so there is no file to remove.
    if (process.platform !== 'win32') {
      await unlink(socketPath).catch((error: unknown) => {
        if (!isErrno(error, 'ENOENT')) throw error;
      });
    }
    const coordinator = new FlightCoordinator({
      tokens: new EpochTokenSource(leadership.epoch),
      graceWindow,
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
        coordinator.serve(
          new SocketConnection<FlightResponse, RequestEnvelope>(
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
    return new FlightServer(server, connections, leadership);
  }

  /**
   * Hands the term over. Ending every connection tells the other processes to
   * elect a successor and reassert their flights during its grace window;
   * `close` alone would wait for clients that never disconnect on their own.
   * Each connection ends only after what was written to it, such as an
   * outcome for a joiner, is sent. The term ends only after the socket is
   * gone: in the other order, this close could remove a successor's socket file.
   */
  async close() {
    const closed = new Promise<void>((resolve) =>
      this.#server.close(() => resolve()),
    );
    for (const socket of this.#connections) socket.destroySoon();
    await closed;
    await this.#leadership.resign();
  }
}
