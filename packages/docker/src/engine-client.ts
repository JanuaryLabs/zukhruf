import { setMaxListeners } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { type Duplex, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ConnectionFailedError,
  DockerEngineError,
  DockerError,
} from './errors.ts';
import type { Filters } from './options.ts';
import { SshExitError } from './ssh-connection.ts';
import type { Transport } from './transport.ts';

/** The query of a request. An array repeats the parameter; `filters` goes to the engine as JSON. */
export type Query = Record<
  string,
  string | number | boolean | string[] | Filters | undefined
>;

export interface EngineRequestOptions {
  query?: Query | undefined;
  /** Goes to the engine as JSON. */
  body?: unknown;
  /** Goes to the engine as it is, with its media type, in place of a JSON body. */
  content?:
    { type: string; data: Uint8Array | AsyncIterable<Uint8Array> } | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}

export interface EngineResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A connection that the engine upgraded to a two-way stream of bytes. */
export interface HijackedConnection {
  /** The output of the engine, then the input to the engine. */
  readonly socket: Duplex;
  /** The bytes of the output that came with the answer, before the first read of the socket. */
  readonly head: Buffer;
  /** The Content-Type of the answer: application/vnd.docker.multiplexed-stream or application/vnd.docker.raw-stream. */
  readonly contentType: string;
  /** Ends the input through the end of input of the transport. The output stays open. */
  endInput(): void;
}

/** What #open gives: an answer, or an answer that upgraded the connection. */
type Opened =
  | { response: IncomingMessage; upgrade?: never }
  | { response: IncomingMessage; upgrade: { socket: Duplex; head: Buffer } };

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
    if (Array.isArray(value)) {
      for (const each of value) parameters.append(key, each);
      continue;
    }
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
  /**
   * The bodies of streamed answers and the hijacked connections that are
   * open. After an upgrade, the agent of the transport no longer has the
   * socket, so only this set lets close() reach it.
   */
  readonly #streams: Set<Readable>;
  /** Aborts when close() starts. Its reason is the DockerError of the disposal. */
  readonly #disposal: AbortController;

  constructor(
    host: string,
    transport: Transport,
    apiVersion?: string,
    streams = new Set<Readable>(),
    disposal = new AbortController(),
  ) {
    this.#host = host;
    this.#transport = transport;
    this.#apiVersion = apiVersion;
    this.#streams = streams;
    this.#disposal = disposal;
    // Each request in flight listens to the disposal, so many concurrent requests are not a leak.
    setMaxListeners(0, disposal.signal);
  }

  /** The same engine and connections, with the API version in the path of each request. */
  versioned(apiVersion: string): EngineClient {
    return new EngineClient(
      this.#host,
      this.#transport,
      apiVersion,
      this.#streams,
      this.#disposal,
    );
  }

  /**
   * Closes each connection, and resolves when each one is closed. A request
   * in flight, a request that starts after close() started, and an iteration
   * of a stream that is open reject with a DockerError that says that the
   * client was disposed.
   */
  async close(): Promise<void> {
    const error = new DockerError(
      'The client was disposed, so it closed this connection to the engine.',
    );
    this.#disposal.abort(error);
    for (const stream of this.#streams) stream.destroy(error);
    this.#streams.clear();
    await this.#transport.close();
  }

  #hold(stream: Readable): void {
    this.#streams.add(stream);
    stream.once('close', () => this.#streams.delete(stream));
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
    const { response } = await this.#open(method, path, options);
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
    const { response } = await this.#open(method, path, options);
    const status = response.statusCode ?? 0;
    if (status >= 200 && status <= 299) {
      this.#hold(response);
      return response;
    }
    const body = await readAll(response);
    throw this.error({ status, headers: response.headers, body }, method, path);
  }

  /**
   * Sends a request that the engine upgrades to a hijacked connection, for an
   * attach and for the start of an exec. An answer without an upgrade
   * rejects with DockerEngineError.
   */
  async hijack(
    method: string,
    path: string,
    options: EngineRequestOptions = {},
  ): Promise<HijackedConnection> {
    const { response, upgrade } = await this.#open(
      method,
      path,
      {
        ...options,
        headers: { ...options.headers, Connection: 'Upgrade', Upgrade: 'tcp' },
      },
      true,
    );
    if (upgrade === undefined) {
      const body = await readAll(response);
      throw this.error(
        { status: response.statusCode ?? 0, headers: response.headers, body },
        method,
        path,
      );
    }
    const { socket, head } = upgrade;
    this.#hold(socket);
    const transport = this.#transport;
    return {
      socket,
      head,
      contentType: response.headers['content-type'] ?? '',
      endInput: () => transport.endInput(socket),
    };
  }

  /** The DockerEngineError of an answer that is not 2xx. */
  error(
    response: EngineResponse,
    method: string,
    path: string,
  ): DockerEngineError {
    return new DockerEngineError(engineMessage(response), {
      status: response.status,
      request: { method, path },
    });
  }

  async #open(
    method: string,
    path: string,
    { query, body, content, headers, signal }: EngineRequestOptions,
    upgrades = false,
  ): Promise<Opened> {
    signal?.throwIfAborted();
    const disposal = this.#disposal.signal;
    disposal.throwIfAborted();
    const prefix =
      this.#apiVersion === undefined ? '' : `/v${this.#apiVersion}`;
    const payload =
      body === undefined
        ? content?.data
        : new TextEncoder().encode(JSON.stringify(body));
    const contentType = body === undefined ? content?.type : 'application/json';
    const { promise, resolve, reject } = Promise.withResolvers<Opened>();
    const request = this.#transport.request({
      method,
      path: `${prefix}${path}${search(query)}`,
      headers: {
        ...headers,
        ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
        ...(payload instanceof Uint8Array
          ? { 'Content-Length': payload.byteLength }
          : {}),
      },
    });
    const responses: IncomingMessage[] = [];
    const abort = () => {
      reject(signal?.reason);
      request.destroy();
      for (const response of responses) response.destroy(signal?.reason);
    };
    // The disposal ends the exchange as an abort of the signal does, with the DockerError of the disposal.
    const dispose = () => {
      reject(disposal.reason);
      request.destroy();
      for (const response of responses) response.destroy(disposal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    disposal.addEventListener('abort', dispose, { once: true });
    const release = () => {
      signal?.removeEventListener('abort', abort);
      disposal.removeEventListener('abort', dispose);
    };
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
      resolve({ response });
    });
    if (upgrades) {
      // The caller owns the socket after the upgrade, and its signal too.
      request.on('upgrade', (response, socket, head) => {
        release();
        resolve({ response, upgrade: { socket, head } });
      });
    }
    if (payload === undefined || payload instanceof Uint8Array) {
      request.end(payload);
    } else {
      // A body that comes as a stream goes with chunked encoding, at the pace of the connection.
      pipeline(Readable.from(payload), request).catch((error: unknown) => {
        request.destroy(error instanceof Error ? error : undefined);
      });
    }
    try {
      return await promise;
    } catch (error) {
      release();
      throw error;
    }
  }
}
