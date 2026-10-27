/**
 * A stand-in engine for fault-injection tests: an HTTP server on a Unix
 * socket of its own that forwards each request to a local engine. A test
 * points a runner at `host` and holds, delays or refuses chosen requests.
 */
import { EventEmitter, once } from 'node:events';
import { rm } from 'node:fs/promises';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request as forward,
} from 'node:http';
import { type Socket, connect } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import {
  type TemporaryDirectory,
  TemporaryFiles,
} from '../fs/temporary-files.ts';

/** A request that reached the proxy. `path` has no API version and no query. */
export interface ProxiedRequest {
  method: string;
  path: string;
}

/** Runs before the proxy forwards a matching request: await to hold or delay it, throw to refuse it. */
export type Intercept = (request: ProxiedRequest) => unknown;

const unversioned = (url: string): string =>
  new URL(url, 'http://engine').pathname.replace(/^\/v\d+\.\d+(?=\/)/, '');

export class EngineProxy implements AsyncDisposable {
  /** The Unix socket of the local engine that the proxy forwards to. */
  readonly #engine: string;
  readonly #directory: TemporaryDirectory;
  readonly #intercepts: {
    method: string;
    path: string | RegExp;
    intercept: Intercept;
  }[] = [];
  readonly #sockets = new Set<Socket | Duplex>();
  /** The intercepted requests that the engine has not answered yet. */
  #unanswered = 0;
  /** Emits 'answered' when the engine answers an intercepted request. */
  readonly #answers = new EventEmitter();
  readonly #server: Server;
  /** Each request in the order it arrived, also the ones refused. */
  readonly requests: ProxiedRequest[] = [];

  private constructor(engine: string, directory: TemporaryDirectory) {
    this.#engine = engine;
    this.#directory = directory;
    this.#server = createServer({ requestTimeout: 0 }, (request, response) => {
      void this.#forward(request, response);
    });
    this.#server.on('connection', (socket) => this.#track(socket));
    this.#server.on('upgrade', (request, socket, head) => {
      void this.#upgrade(request, socket, head);
    });
  }

  /** Starts a proxy to the engine at `engine`, a `unix://` host. */
  static async start(engine: string): Promise<EngineProxy> {
    if (!engine.startsWith('unix://'))
      throw new Error(`The engine proxy forwards to unix:// only: ${engine}`);
    const proxy = new EngineProxy(
      engine.slice('unix://'.length),
      await new TemporaryFiles().directory('zukhruf-proxy-'),
    );
    await proxy.listen();
    return proxy;
  }

  get #path(): string {
    return join(this.#directory.path, 'engine.sock');
  }

  /** The host to put in DOCKER_HOST. */
  get host(): string {
    return `unix://${this.#path}`;
  }

  /** Runs `intercept` before each request with this method and path. A RegExp path matches a path that has an ID, such as `/containers/<id>/start`. */
  intercept(method: string, path: string | RegExp, intercept: Intercept): void {
    this.#intercepts.push({ method, path, intercept });
  }

  /** Listens at the same path again after close(). */
  async listen(): Promise<void> {
    await rm(this.#path, { force: true });
    this.#server.listen(this.#path);
    await once(this.#server, 'listening');
  }

  /** Stops listening and ends every open connection: the engine is gone. */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) =>
      this.#server.close(() => resolve()),
    );
    for (const socket of this.#sockets) socket.destroy();
    await closed;
  }

  /** Waits until the engine answers each intercepted request, then closes. */
  async [Symbol.asyncDispose](): Promise<void> {
    while (this.#unanswered > 0) await once(this.#answers, 'answered');
    if (this.#server.listening) await this.close();
    await this.#directory.cleanup();
  }

  #track(socket: Socket | Duplex): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
  }

  async #forward(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const proxied = {
      method: request.method ?? 'GET',
      path: unversioned(request.url ?? '/'),
    };
    this.requests.push(proxied);
    // Read the whole body first: a held request reaches the engine even
    // after its client is gone, as one that the engine already received.
    const chunks: Buffer[] = await Array.fromAsync(request);
    const matching = this.#intercepts.filter(
      ({ method, path }) =>
        method === proxied.method &&
        (typeof path === 'string'
          ? path === proxied.path
          : path.test(proxied.path)),
    );
    let pending = matching.length > 0;
    if (pending) this.#unanswered += 1;
    const answered = () => {
      if (!pending) return;
      pending = false;
      this.#unanswered -= 1;
      this.#answers.emit('answered');
    };
    try {
      for (const { intercept } of matching) await intercept(proxied);
    } catch (error) {
      answered();
      response.writeHead(502).end(String(error));
      return;
    }
    const upstream = forward({
      socketPath: this.#engine,
      method: request.method,
      path: request.url,
      headers: request.headers,
    });
    upstream.on('socket', (socket) => this.#track(socket));
    upstream.once('close', answered);
    // A client that left ends its long poll, such as a wait. The engine
    // keeps an intercepted request: it already has it.
    if (matching.length === 0) response.once('close', () => upstream.destroy());
    upstream.on('response', (answer) => {
      if (response.destroyed) {
        answer.resume();
        return;
      }
      response.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      // The engine sends the headers of a long poll, such as a wait, before
      // its body, and the Docker CLI waits for them.
      response.flushHeaders();
      answer.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    upstream.end(Buffer.concat(chunks));
  }

  /** Pipes a hijacked connection, such as an attach or an exec, raw. */
  async #upgrade(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    this.requests.push({
      method: request.method ?? 'GET',
      path: unversioned(request.url ?? '/'),
    });
    // Node gives the body of the upgrade request, such as the JSON of an
    // exec start, to the request, and only the bytes after it to `head`.
    const chunks: Buffer[] = await Array.fromAsync(request);
    const engine = connect(this.#engine);
    this.#track(engine);
    const headers: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      headers.push(
        `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`,
      );
    engine.write(
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`,
    );
    engine.write(Buffer.concat([...chunks, head]));
    client.on('error', () => engine.destroy());
    engine.on('error', () => client.destroy());
    client.pipe(engine).pipe(client);
  }
}
