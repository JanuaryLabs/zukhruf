import type { IncomingHttpHeaders } from 'node:http';

import { ConnectionFailedError, DockerEngineError } from './errors.ts';
import type { Filters } from './options.ts';
import { SshExitError } from './ssh-connection.ts';
import type { Transport } from './transport.ts';

/** The query of a request. `filters` goes to the engine as JSON. */
export type Query = Record<
  string,
  string | number | boolean | Filters | undefined
>;

export interface EngineRequestOptions {
  query?: Query | undefined;
  signal?: AbortSignal | undefined;
}

export interface EngineResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** The socket errors that mean the engine did not accept the connection. ENOENT is also an absent `ssh`. */
const CONNECTION_FAILURES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'EPIPE',
  'ECONNRESET',
]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function search(query: Query | undefined): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    parameters.set(
      key,
      typeof value === 'object' ? JSON.stringify(value) : String(value),
    );
  }
  const text = parameters.toString();
  return text ? `?${text}` : '';
}

/** The message of an error answer of the engine: {"message": "..."}, or the text itself. */
function engineMessage(response: EngineResponse): string {
  const text = response.body.toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    const message: unknown = Reflect.get(Object(parsed), 'message');
    if (typeof message === 'string') return message;
  } catch {
    // The answer is not JSON: its text is the message.
  }
  return text.trim();
}

/** Sends requests of the Engine API to one engine. */
export class EngineClient {
  readonly #host: string;
  readonly #transport: Transport;
  readonly #apiVersion: string | undefined;

  constructor(host: string, transport: Transport, apiVersion?: string) {
    this.#host = host;
    this.#transport = transport;
    this.#apiVersion = apiVersion;
  }

  /** The same engine and connections, with the API version in the path of each request. */
  versioned(apiVersion: string): EngineClient {
    return new EngineClient(this.#host, this.#transport, apiVersion);
  }

  /** Sends a request. A status that is not 2xx rejects with DockerEngineError. */
  async request(
    method: string,
    path: string,
    options: EngineRequestOptions = {},
  ): Promise<EngineResponse> {
    const response = await this.#send(method, path, options);
    if (response.status < 200 || response.status > 299) {
      throw new DockerEngineError(engineMessage(response), {
        status: response.status,
        method,
        path,
      });
    }
    return response;
  }

  /** Sends a request and gives its JSON body. */
  async json<T>(
    method: string,
    path: string,
    options: EngineRequestOptions = {},
  ): Promise<T> {
    const response = await this.request(method, path, options);
    const body: T = JSON.parse(response.body.toString('utf8'));
    return body;
  }

  async #send(
    method: string,
    path: string,
    { query, signal }: EngineRequestOptions,
  ): Promise<EngineResponse> {
    signal?.throwIfAborted();
    const prefix =
      this.#apiVersion === undefined ? '' : `/v${this.#apiVersion}`;
    const { promise, resolve, reject } =
      Promise.withResolvers<EngineResponse>();
    const request = this.#transport.request({
      method,
      path: `${prefix}${path}${search(query)}`,
    });
    const abort = () => {
      reject(signal?.reason);
      request.destroy();
    };
    signal?.addEventListener('abort', abort, { once: true });
    let answered = false;
    request.on('error', (error) => {
      // An error after the answer started is not a connection failure.
      reject(
        !answered &&
          (error instanceof SshExitError ||
            CONNECTION_FAILURES.has(errorCode(error) ?? ''))
          ? new ConnectionFailedError(this.#host, { cause: error })
          : error,
      );
    });
    request.on('response', (response) => {
      answered = true;
      response.on('error', reject);
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.end();
    try {
      return await promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}
