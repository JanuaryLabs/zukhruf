import {
  Agent,
  type ClientRequest,
  type RequestOptions,
  request,
} from 'node:http';
import type { Duplex } from 'node:stream';

/** The connections of a client to its engine. */
export interface Transport {
  request(options: RequestOptions): ClientRequest;
  /** Ends the input of a hijacked connection, and keeps its output open. */
  endInput(socket: Duplex): void;
  /** Closes each connection, idle or in use, and resolves when each one is closed. */
  close(): Promise<void>;
}

/**
 * The connections to one engine through a Unix socket or a Windows named pipe.
 * It keeps idle connections for the next request, and an idle connection does
 * not keep the process running: the agent unrefs each free socket.
 */
export class SocketTransport implements Transport {
  readonly #kind: 'unix' | 'npipe';
  readonly #socketPath: string;
  readonly #agent = new Agent({ keepAlive: true });

  constructor(kind: 'unix' | 'npipe', socketPath: string) {
    this.#kind = kind;
    this.#socketPath = socketPath;
  }

  request(options: RequestOptions): ClientRequest {
    return request({
      ...options,
      agent: this.#agent,
      socketPath: this.#socketPath,
    });
  }

  /**
   * A Unix socket shuts down its write side. A named pipe has no shutdown of
   * one side: the engine reads a message of zero bytes as the end, as
   * CloseWrite of go-winio sends it.
   */
  endInput(socket: Duplex): void {
    if (this.#kind === 'npipe') socket.write(Buffer.alloc(0));
    socket.end();
  }

  async close(): Promise<void> {
    this.#agent.destroy();
  }
}
