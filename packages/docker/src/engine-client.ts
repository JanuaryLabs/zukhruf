import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

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
  /** Goes to the engine as JSON. */
  body?: unknown;
  headers?: Record<string, string> | undefined;
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

/** True for a 2xx status. */
export function isSuccess(response: EngineResponse): boolean {
  return response.status >= 200 && response.status <= 299;
}

/** The JSON body of an answer. */
export function parseBody<T>(response: EngineResponse): T {
  const body: T = JSON.parse(response.body.toString('utf8'));
  return body;
}

async function readAll(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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
    const response = await this.exchange(method, path, options);
    if (!isSuccess(response)) throw this.error(response, method, path);
    return response;
  }

  /** Sends a request and gives its JSON body. */
  async json<T>(
    method: string,
    path: string,
    options: EngineRequestOptions = {},
  ): Promise<T> {
    return parseBody<T>(await this.request(method, path, options));
  }

  /** Sends a request and gives the answer with each status. */
  async exchange(
    method: string,
    path: string,
    options: EngineRequestOptions = {},
  ): Promise<EngineResponse> {
    const response = await this.#open(method, path, options);
    return {
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: await readAll(response),
    };
  }

  /**
   * Sends a request and gives the body of a 2xx answer as it comes. An abort
   * of the signal rejects the read of the body with its reason. Each other
   * status rejects with DockerEngineError.
   */
  async stream(
    method: string,
    path: string,
    options: EngineRequestOptions = {},
  ): Promise<IncomingMessage> {
    const response = await this.#open(method, path, options);
    const status = response.statusCode ?? 0;
    if (status >= 200 && status <= 299) return response;
    const body = await readAll(response);
    throw this.error({ status, headers: response.headers, body }, method, path);
  }

  /** The DockerEngineError of an answer that is not 2xx. */
  error(
    response: EngineResponse,
    method: string,
    path: string,
  ): DockerEngineError {
    return new DockerEngineError(engineMessage(response), {
      status: response.status,
      method,
      path,
    });
  }

  async #open(
    method: string,
    path: string,
    { query, body, headers, signal }: EngineRequestOptions,
  ): Promise<IncomingMessage> {
    signal?.throwIfAborted();
    const prefix =
      this.#apiVersion === undefined ? '' : `/v${this.#apiVersion}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const { promise, resolve, reject } =
      Promise.withResolvers<IncomingMessage>();
    const request = this.#transport.request({
      method,
      path: `${prefix}${path}${search(query)}`,
      headers: {
        ...headers,
        ...(payload === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }),
      },
    });
    const responses: IncomingMessage[] = [];
    const abort = () => {
      reject(signal?.reason);
      request.destroy();
      for (const response of responses) response.destroy(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const release = () => signal?.removeEventListener('abort', abort);
    request.on('error', (error) => {
      // An error after the answer started is not a connection failure.
      reject(
        responses.length === 0 &&
          (error instanceof SshExitError ||
            CONNECTION_FAILURES.has(errorCode(error) ?? ''))
          ? new ConnectionFailedError(this.#host, { cause: error })
          : error,
      );
    });
    request.on('response', (response) => {
      responses.push(response);
      response.once('close', release);
      resolve(response);
    });
    request.end(payload);
    try {
      return await promise;
    } catch (error) {
      release();
      throw error;
    }
  }
}
