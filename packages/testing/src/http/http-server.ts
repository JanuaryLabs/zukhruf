import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http';

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
  /** Stop accepting requests and close active HTTP connections. */
  cleanup: () => Promise<void>;
}

/** A server whose scope is the process: nothing disposes it. */
export interface BackgroundHttpServer {
  origin: string;
}

/** Each acquisition owns a loopback HTTP server on an available port. */
export class HttpServer {
  async start(handler: HttpHandler): Promise<HttpServerHandle> {
    await using resources = new AsyncDisposableStack();
    const server = serve(handler);
    await listen(server);

    resources.defer(async () => {
      const closed = server[Symbol.asyncDispose]();
      server.closeAllConnections();
      await closed;
    });
    const origin = originOf(server);
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return {
      origin,
      server,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }

  /** Serves until the process exits and never keeps it running, even while a connection is open. */
  async background(handler: HttpHandler): Promise<BackgroundHttpServer> {
    const server = serve(handler);
    server.on('connection', (socket) => socket.unref());
    await listen(server);
    server.unref();
    return { origin: originOf(server) };
  }
}

function serve(handler: HttpHandler): Server {
  return createServer((request, response) => {
    void handler(request, response);
  });
}

async function listen(server: Server): Promise<void> {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
}

function originOf(server: Server): string {
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
