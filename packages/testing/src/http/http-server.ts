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

/** Each acquisition owns a loopback HTTP server on an available port. */
export class HttpServer {
  async start(handler: HttpHandler): Promise<HttpServerHandle> {
    await using resources = new AsyncDisposableStack();
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;

    resources.defer(async () => {
      const closed = server[Symbol.asyncDispose]();
      server.closeAllConnections();
      await closed;
    });
    const address = server.address();
    assert(address && typeof address === 'object');
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
