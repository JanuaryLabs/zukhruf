import { once } from 'node:events';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

/** The answer of the engine to an attach or to the start of an exec, as Moby writes it. */
const UPGRADED =
  'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n';

export interface FakeEngineOptions {
  /** The directory that holds the socket. */
  directory: string;
  /** The Api-Version header of GET /_ping. */
  apiVersion: string;
  /** Answers each request that is not GET /_ping. The default answers 404. */
  answer?: (request: IncomingMessage, response: ServerResponse) => void;
  /** GET /_ping never gets an answer. */
  silentPing?: boolean;
  /**
   * Answers each upgrade request, an attach or the start of an exec, with 101
   * and a multiplexed stream, and gives the socket. The sockets of such an
   * engine have a high-water mark of one byte: after the upgrade, a socket
   * reads at most one chunk of 64 KB of the input that the handler does not
   * read, and the rest stays in the kernel, so a close of the socket is a
   * close with unread input.
   */
  hijack?: (request: IncomingMessage, socket: Duplex) => void;
}

/**
 * An engine on a Unix socket that answers GET /_ping with a chosen Api-Version
 * header and records the path of each request. It keeps idle connections open
 * with no time limit, as a real engine does. Disposal closes it.
 */
export async function fakeEngine(options: FakeEngineOptions) {
  const socketPath = join(options.directory, 'engine.sock');
  const paths: string[] = [];
  const sockets = new Set<Socket>();
  const allClosed = Promise.withResolvers<void>();
  const { hijack } = options;
  const server = createServer(
    hijack ? { highWaterMark: 1 } : {},
    (request, response) => {
      paths.push(request.url ?? '');
      if (request.method === 'GET' && request.url === '/_ping') {
        if (options.silentPing) return;
        response.writeHead(200, {
          'Api-Version': options.apiVersion,
          'Content-Type': 'text/plain',
        });
        response.end('OK');
        return;
      }
      if (options.answer) {
        options.answer(request, response);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'page not found' }));
    },
  );
  if (hijack) {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      paths.push(request.url ?? '');
      // The client resets the connection when it stops reading.
      socket.on('error', () => undefined);
      socket.write(UPGRADED);
      hijack(request, socket);
    });
  }
  server.keepAliveTimeout = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) allClosed.resolve();
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return {
    host: `unix://${socketPath}`,
    socketPath,
    /** The path and query of each request, in order. */
    paths,
    /** The connections that are open now. */
    get openConnections() {
      return sockets.size;
    },
    /** Resolves when each connection that the engine accepted is closed. */
    allConnectionsClosed: allClosed.promise,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      // An upgraded connection is no longer a connection of the HTTP server.
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
