import { Future } from './future.ts';

/**
 * Work that runs until its owner stops it. `start` runs the work with a
 * signal, and a dispose aborts the signal and waits for the end of the work.
 * The name is the one of .NET `BackgroundService`.
 */
export class BackgroundService implements AsyncDisposable {
  readonly #stop = new AbortController();
  readonly #ended: Future<void>;

  private constructor(execute: (signal: AbortSignal) => Promise<void>) {
    const { signal } = this.#stop;
    this.#ended = Future.run(async () => {
      try {
        await execute(signal);
      } catch (error) {
        // An end by the stop is no failure, as .NET does not report an
        // OperationCanceledException after its stoppingToken.
        if (!signal.aborted || error !== signal.reason) throw error;
      }
    });
  }

  /** Runs `execute(signal)` at once. A sync throw of `execute` is a failure of the work. */
  static start(
    execute: (signal: AbortSignal) => Promise<void>,
  ): BackgroundService {
    return new BackgroundService(execute);
  }

  /** Resolves when the work ends, and rejects with its failure. */
  get ended(): Promise<void> {
    return this.#ended.wait();
  }

  /** Aborts the signal of the work, waits for its end, and rejects with its failure. */
  async [Symbol.asyncDispose](): Promise<void> {
    this.#stop.abort();
    await this.#ended.wait();
  }
}
