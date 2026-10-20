import {
  Agent,
  type ClientRequest,
  type RequestOptions,
  request,
} from 'node:http';

/** The connections of a client to its engine. */
export interface Transport {
  request(options: RequestOptions): ClientRequest;
  /** Closes each connection, idle or in use, and resolves when each one is closed. */
  close(): Promise<void>;
}

/**
 * The connections to one engine through a Unix socket or a Windows named pipe.
 * It keeps idle connections for the next request, and an idle connection does
 * not keep the process running: the agent unrefs each free socket.
 */
export class SocketTransport implements Transport {
  readonly #socketPath: string;
  readonly #agent = new Agent({ keepAlive: true });

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  request(options: RequestOptions): ClientRequest {
    return request({
      ...options,
      agent: this.#agent,
      socketPath: this.#socketPath,
    });
  }

  async close(): Promise<void> {
    this.#agent.destroy();
  }
}
