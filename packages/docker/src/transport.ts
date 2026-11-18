import {
  Agent,
  type ClientRequest,
  type ClientRequestArgs,
  type RequestOptions,
  request,
} from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * One connection to the engine. The keep-alive agent refs a connection that
 * it gives to a request and unrefs one that it keeps idle (`keepSocketAlive`
 * and `reuseSocket` of Node's http.Agent), and it calls setKeepAlive() and
 * setTimeout() on each one that it keeps.
 */
export interface Connection extends Duplex {
  ref(): unknown;
  unref(): unknown;
  setKeepAlive(enable?: boolean, initialDelay?: number): unknown;
  setTimeout(timeout: number): unknown;
}

/** How a transport reaches its engine. */
export interface Dialer {
  /**
   * Opens one connection: at once, as net.connect() gives a socket that
   * connects after, or when it opened, as an SSH channel. A socket's failure
   * comes as its 'error'; a channel's as the rejection.
   */
  dial(): Connection | Promise<Connection>;
  /** Ends the input of a hijacked connection, and keeps its output open. */
  endInput(connection: Duplex): void;
  /** True for an error that a connection of this dialer fails with, before the engine answered. */
  isConnectionFailure(error: unknown): boolean;
  /** Closes what the connections run on, after each connection closed. */
  close(): Promise<void>;
}

/** The connection codes that are a ConnectionFailedError when they come before the answer. ECONNRESET is also the "socket hang up" of Node. */
const CONNECTION_FAILURES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'EACCES',
  'EPIPE',
  'ECONNRESET',
]);

/** True for the error of a socket that did not open or broke before the answer, with one of the codes of CONNECTION_FAILURES. */
export function isSocketFailure(error: unknown): boolean {
  const code: unknown = Reflect.get(Object(error), 'code');
  return typeof code === 'string' && CONNECTION_FAILURES.has(code);
}

/** The connections to an engine through a Unix socket or a Windows named pipe. */
export class SocketDialer implements Dialer {
  readonly #kind: 'unix' | 'npipe';
  readonly #socketPath: string;

  constructor(kind: 'unix' | 'npipe', socketPath: string) {
    this.#kind = kind;
    this.#socketPath = socketPath;
  }

  dial(): Connection {
    return connect(this.#socketPath);
  }

  /**
   * A Unix socket shuts down its write side. A named pipe has no shutdown of
   * one side: the engine reads a message of zero bytes as the end, as
   * CloseWrite of go-winio sends it.
   */
  endInput(connection: Duplex): void {
    if (this.#kind === 'npipe') connection.write(Buffer.alloc(0));
    connection.end();
  }

  isConnectionFailure(error: unknown): boolean {
    return isSocketFailure(error);
  }

  /** A socket needs nothing more than its own close. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The keep-alive agent of a transport: each new connection comes from the dialer. */
class DialerAgent extends Agent {
  readonly #dial: () => Connection | Promise<Connection>;

  constructor(dial: () => Connection | Promise<Connection>) {
    super({ keepAlive: true });
    this.#dial = dial;
  }

  /** A connection that opens later goes to the callback, as Node's Agent takes it (`createSocket` in Node's _http_agent.js). */
  override createConnection(
    _options: ClientRequestArgs,
    callback: (error: Error | null, connection?: Duplex) => void,
  ): Duplex | undefined {
    const dialed = this.#dial();
    if (!(dialed instanceof Promise)) return dialed;
    dialed.then(
      (connection) => callback(null, connection),
      (error: unknown) =>
        callback(Error.isError(error) ? error : new Error(String(error))),
    );
    return undefined;
  }
}

/**
 * The HTTP connections of a client to its engine, over the connections of a
 * dialer. It keeps idle connections for the next request, and an idle
 * connection does not keep the process running: the agent unrefs each one
 * that it keeps.
 */
export class Transport {
  readonly #dialer: Dialer;
  readonly #agent: DialerAgent;
  /** Each connection until it closes, also after an upgrade takes it from the agent. */
  readonly #connections = new Map<Duplex, Connection>();

  constructor(dialer: Dialer) {
    this.#dialer = dialer;
    const hold = (connection: Connection): Connection => {
      this.#connections.set(connection, connection);
      connection.once('close', () => this.#connections.delete(connection));
      return connection;
    };
    this.#agent = new DialerAgent(() => {
      const dialed = dialer.dial();
      return dialed instanceof Promise ? dialed.then(hold) : hold(dialed);
    });
  }

  request(options: RequestOptions): ClientRequest {
    return request({ ...options, agent: this.#agent });
  }

  /** Ends the input of a hijacked connection, and keeps its output open. */
  endInput(socket: Duplex): void {
    this.#dialer.endInput(socket);
  }

  /** Lets a connection in use, such as a hijacked one, end without the process waiting for it. */
  unref(socket: Duplex): void {
    this.#connections.get(socket)?.unref();
  }

  /** True for an error of a request that is a ConnectionFailedError when it comes before the answer. */
  isConnectionFailure(error: unknown): boolean {
    return this.#dialer.isConnectionFailure(error);
  }

  /** Closes each connection, idle, in use or upgraded, then what they run on, and resolves when each one is closed. */
  async close(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#agent.destroy();
    // A connection in the map has not emitted 'close', also when it is
    // destroyed: `closed` of a destroyed net.Socket is true before the event.
    // The wait is not once() of node:events, which rejects on the 'error' of
    // a connection that the client destroyed with the error of the disposal.
    await Promise.all(
      connections.map((connection) => {
        const closed = new Promise<void>((resolve) =>
          connection.once('close', () => resolve()),
        );
        connection.destroy();
        return closed;
      }),
    );
    await this.#dialer.close();
  }
}
