import type { Duplex } from 'node:stream';

import type { HijackedConnection } from './engine-client.ts';
import { DockerError } from './errors.ts';
import { type OutputChunk, outputChunks } from './multiplexed-stream.ts';
import { type ExecResult, readOutput } from './output.ts';

export interface ContainerProcessOptions {
  /** Gives the process a writable `stdin`. */
  stdin: boolean;
  /** An abort rejects the iteration with the reason of the signal. It does not stop the command. */
  signal?: AbortSignal | undefined;
  /**
   * Gives the exit code. `outputEnded` resolves when the output ends, and
   * rejects when the iteration ends first.
   */
  exitCode: (outputEnded: Promise<void>) => Promise<number>;
}

async function* withHead(
  head: Buffer,
  socket: Duplex,
): AsyncGenerator<Uint8Array> {
  if (head.byteLength > 0) yield head;
  for await (const chunk of socket) {
    if (chunk instanceof Uint8Array) yield chunk;
  }
}

/** Writes to the socket and resolves when the socket took the bytes. */
async function write(socket: Duplex, chunk: Uint8Array): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.write(chunk, (error) => (error ? reject(error) : resolve()));
  return promise;
}

/**
 * An exec or an attached container: one stream of output chunks in the order
 * of the engine, given once, a writable `stdin` when it has one, and the exit
 * code when it ends.
 */
export class ContainerProcess implements AsyncIterable<OutputChunk> {
  /** Present with { stdin: true }. Only close() ends the input; an empty write is dropped. */
  readonly stdin: WritableStream<Uint8Array> | undefined;
  /** Holds the chunks until the first iteration takes them. */
  readonly #unread: AsyncGenerator<OutputChunk>[];
  readonly #exitCode: () => Promise<number>;

  constructor(
    connection: HijackedConnection,
    options: ContainerProcessOptions,
  ) {
    const { socket, head, contentType } = connection;
    const { signal } = options;
    // An error before the first read waits for the iteration, which rejects with it.
    socket.on('error', () => undefined);
    const abort = () => socket.destroy(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal?.removeEventListener('abort', abort));

    const outputEnded = Promise.withResolvers<void>();
    outputEnded.promise.catch(() => undefined);
    async function* read(): AsyncGenerator<OutputChunk> {
      try {
        signal?.throwIfAborted();
        yield* outputChunks(withHead(head, socket), contentType);
        outputEnded.resolve();
      } catch (error) {
        outputEnded.reject(error);
        throw error;
      } finally {
        outputEnded.reject(
          new DockerError('The iteration ended before the output ended.'),
        );
        socket.destroy();
      }
    }
    this.#unread = [read()];

    const exitCode = options.exitCode(outputEnded.promise);
    // A caller that never reads the exit code gets no unhandled rejection.
    exitCode.catch(() => undefined);
    this.#exitCode = () => exitCode;

    this.stdin = options.stdin
      ? new WritableStream<Uint8Array>({
          write: async (chunk) => {
            if (chunk.byteLength > 0) await write(socket, chunk);
          },
          close: () => connection.endInput(),
          abort: () => connection.endInput(),
        })
      : undefined;
  }

  /**
   * The exit code. For an exec, it comes after the output ends. It rejects
   * when the iteration ends before the output ends.
   */
  get exitCode(): Promise<number> {
    return this.#exitCode();
  }

  /** The chunks, once. A second iteration rejects. */
  [Symbol.asyncIterator](): AsyncIterator<OutputChunk> {
    const chunks = this.#unread.pop();
    if (chunks !== undefined) return chunks;
    const error = new DockerError(
      'A container process gives its output once, and an iteration already read it.',
    );
    return { next: async () => Promise.reject(error) };
  }

  /** Reads each chunk and gives the result. */
  async collect(): Promise<ExecResult> {
    const output = await readOutput(this);
    return { exitCode: await this.exitCode, ...output };
  }
}
