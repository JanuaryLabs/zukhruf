import type { Server } from 'node:net';

import type { PipeEndpoint } from './pipe-endpoint.ts';

/** The key of the one call that makes a `PipeServer`. `PipeEndpoint#listen` calls it; the package index does not export it. */
export const ownServer = Symbol('PipeServer.own');

/** The owner of the socket file while it listens on the path of one endpoint. */
export class PipeServer implements AsyncDisposable {
  readonly endpoint: PipeEndpoint;
  readonly #server: Server;

  private constructor(endpoint: PipeEndpoint, server: Server) {
    this.endpoint = endpoint;
    this.#server = server;
  }

  /** Owns a `net.Server` that listens on the path of `endpoint`. */
  static [ownServer](endpoint: PipeEndpoint, server: Server): PipeServer {
    return new PipeServer(endpoint, server);
  }

  /** Lets the program exit while the server listens, as net.Server#unref. */
  unref(): this {
    this.#server.unref();
    return this;
  }

  /** Stops listening; Node removes the socket file at the path. Resolves when closed. Connections that are open stay open (Node's rule); the caller ends them. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
