import { EventEmitter, once } from 'node:events';
import { type Duplex, getDefaultHighWaterMark } from 'node:stream';

import type { HijackedConnection } from './engine-client.ts';
import { DockerError, IncompleteOutputError } from './errors.ts';
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

/** The codes of a write to a connection that the engine closed. */
const WRITE_FAILURES = new Set(['EPIPE', 'ECONNRESET']);

/** What ends the output when the connection ends. */
type Ending =
  | { readonly kind: 'end' }
  | { readonly kind: 'read error'; readonly error: Error }
  | {
      readonly kind: 'failed write';
      readonly error: Error;
      /** No output had come, or the connection was paused. */
      readonly incomplete: boolean;
    };

/**
 * The output bytes of a hijacked connection: the head, then each chunk in
 * order, and how the output ended (ADR 0012). It reads with 'data' events,
 * because the iterator of a destroyed stream drops the chunks that Node
 * already read. It pauses the connection while the caller has not taken the
 * high-water mark of Node, so it reads as fast as the caller iterates.
 */
class HijackedOutput {
  readonly #socket: Duplex;
  readonly #highWaterMark = getDefaultHighWaterMark(false);
  readonly #chunks: Uint8Array[] = [];
  /** Emits 'change' when a chunk comes or the output ends, for the iteration that waits. */
  readonly #arrivals = new EventEmitter();
  #queuedBytes = 0;
  #outputBytes: number;
  #state: { readonly phase: 'reading' | 'ended'; readonly ending: Ending } = {
    phase: 'reading',
    ending: { kind: 'end' },
  };

  constructor(socket: Duplex, head: Buffer) {
    this.#socket = socket;
    this.#outputBytes = head.byteLength;
    if (head.byteLength > 0) this.#push(head);
    socket.on('data', this.#onData);
    socket.on('error', (error) => this.#onError(error));
    socket.once('end', () => this.#end());
    socket.once('close', () => this.#end());
  }

  readonly #onData = (chunk: Buffer) => {
    this.#outputBytes += chunk.byteLength;
    this.#push(chunk);
  };

  #push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#queuedBytes += chunk.byteLength;
    if (this.#queuedBytes >= this.#highWaterMark) this.#socket.pause();
    this.#arrivals.emit('change');
  }

  /**
   * A reset ends the output. The error that follows a failed write is the
   * error of that write, which writeFailed() already has.
   */
  #onError(error: NodeJS.ErrnoException): void {
    const { phase, ending } = this.#state;
    if (phase === 'ended' || ending.kind !== 'end') return;
    if (error.code === 'ECONNRESET') return;
    this.#state = { phase, ending: { kind: 'read error', error } };
  }

  /** A destroyed connection still holds the chunks that Node read while it was paused. */
  #end(): void {
    if (this.#state.phase === 'ended') return;
    this.#socket.off('data', this.#onData);
    for (let rest: unknown = this.#socket.read(); rest !== null;) {
      if (rest instanceof Uint8Array) this.#push(rest);
      rest = this.#socket.read();
    }
    this.#state = { phase: 'ended', ending: this.#state.ending };
    this.#arrivals.emit('change');
  }

  /**
   * Takes a failed write of the input. Node then destroys the connection with
   * the output that is still in the kernel, so the output can be incomplete
   * when no output had come or the connection was paused.
   */
  writeFailed(error: NodeJS.ErrnoException): void {
    const { phase, ending } = this.#state;
    if (phase === 'ended' || ending.kind !== 'end') return;
    if (!WRITE_FAILURES.has(error.code ?? '')) return;
    const incomplete = this.#outputBytes === 0 || this.#socket.isPaused();
    this.#state = {
      phase,
      ending: { kind: 'failed write', error, incomplete },
    };
  }

  /** The error of the failed write, when the output can be incomplete. */
  get incompleteBecause(): { cause: Error } | undefined {
    const { ending } = this.#state;
    return ending.kind === 'failed write' && ending.incomplete
      ? { cause: ending.error }
      : undefined;
  }

  async *chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        this.#queuedBytes -= chunk.byteLength;
        if (this.#queuedBytes < this.#highWaterMark) this.#socket.resume();
        yield chunk;
        continue;
      }
      const { phase, ending } = this.#state;
      if (phase === 'ended') {
        if (ending.kind === 'read error') throw ending.error;
        return;
      }
      await once(this.#arrivals, 'change');
    }
  }
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
    const output = new HijackedOutput(socket, head);
    const abort = () => socket.destroy(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal?.removeEventListener('abort', abort));

    const outputEnded = Promise.withResolvers<void>();
    outputEnded.promise.catch(() => undefined);
    const exitCode = options.exitCode(outputEnded.promise);
    // A caller that never reads the exit code gets no unhandled rejection.
    exitCode.catch(() => undefined);
    this.#exitCode = () => exitCode;

    async function* read(): AsyncGenerator<OutputChunk> {
      try {
        signal?.throwIfAborted();
        yield* outputChunks(output.chunks(), contentType);
        outputEnded.resolve();
        const incomplete = output.incompleteBecause;
        if (incomplete)
          throw new IncompleteOutputError(await exitCode, incomplete);
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

    this.stdin = options.stdin
      ? new WritableStream<Uint8Array>({
          write: async (chunk) => {
            if (chunk.byteLength === 0) return;
            const { promise, resolve, reject } = Promise.withResolvers<void>();
            socket.write(chunk, (error) => {
              if (!error) return resolve();
              output.writeFailed(error);
              reject(error);
            });
            await promise;
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
