import { once } from 'node:events';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';

export interface FakeEngineOptions {
  /** The directory that holds the socket. */
  directory: string;
  /** The Api-Version header of GET /_ping. */
  apiVersion: string;
  /** Answers each request that is not GET /_ping. The default answers 404. */
  answer?: (request: IncomingMessage, response: ServerResponse) => void;
  /** GET /_ping never gets an answer. */
  silentPing?: boolean;
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
  const server = createServer((request, response) => {
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
  });
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
      server.close();
      await once(server, 'close');
    },
  };
}
