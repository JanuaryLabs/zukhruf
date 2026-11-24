import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http';
import { Socket } from 'node:net';

/**
 * Answers one request. It may be async: a rejection stays unhandled and fails
 * the process, as a throw in a synchronous handler does.
 */
export type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => unknown;

export interface HttpServerHandle extends AsyncDisposable {
  origin: string;
  server: Server;
  /** Stop accepting requests, close active HTTP connections, and wait until a client of this process has closed each of them. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns a loopback HTTP server on an available port. */
export class HttpServer {
  async start(handler: HttpHandler): Promise<HttpServerHandle> {
    await using resources = new AsyncDisposableStack();
    const clients = new Set<Socket>();
    const record = (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('socket' in message) ||
        !(message.socket instanceof Socket)
      ) {
        return;
      }
      const { socket } = message;
      clients.add(socket);
      socket.once('close', () => {
        clients.delete(socket);
      });
    };
    subscribe('net.client.socket', record);
    resources.defer(() => {
      unsubscribe('net.client.socket', record);
    });
    const accepted = new Set<Socket>();
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    server.on('connection', (socket) => {
      accepted.add(socket);
      socket.once('close', () => {
        accepted.delete(socket);
      });
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    assert(address && typeof address === 'object');

    resources.defer(async () => {
      const closing = [...accepted]
        .filter((connection) => !connection.destroyed)
        .map((connection) => ({
          connection,
          peers: [...clients].filter(
            (client) =>
              !client.destroyed &&
              client.remoteAddress === address.address &&
              client.remotePort === address.port &&
              client.localPort === connection.remotePort,
          ),
        }));
      const closed = server[Symbol.asyncDispose]();
      server.closeAllConnections();
      await closed;
      await Promise.all(
        closing
          .filter(
            ({ connection, peers }) => connection.destroyed && peers.length > 0,
          )
          .map(({ peers }) =>
            Promise.race(
              peers.map(
                (client) =>
                  new Promise((resolve) => {
                    client.once('close', resolve);
                  }),
              ),
            ),
          ),
      );
    });
    const origin = `http://127.0.0.1:${address.port}`;
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return {
      origin,
      server,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
