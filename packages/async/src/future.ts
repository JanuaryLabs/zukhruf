import { Latch } from './latch.ts';

/**
 * The outcome of work that ends once: a value or a failure. The first resolve
 * or reject settles it, and every wait, early or late, gets that value or
 * rejects with that reason. It keeps the failure as data, so only a wait
 * rejects, and a failure that nobody waits for leaves no unhandled rejection.
 */
export class Future<T> {
  readonly #outcome = new Latch<PromiseSettledResult<T>>();

  /** Settles the future with the outcome of `work`. A work that throws at once fails as an async work does. */
  static run<T>(work: () => Promise<T>): Future<T> {
    const future = new Future<T>();
    void Promise.allSettled([Promise.try(work)]).then(([outcome]) =>
      future.#outcome.open(outcome),
    );
    return future;
  }

  /**
   * A settled future ignores it. A type that names a promise is refused: the
   * future would adopt the promise, and its value could then be a failure.
   */
  resolve(value: T extends PromiseLike<unknown> ? never : T): void {
    this.#outcome.open({ status: 'fulfilled', value });
  }

  /** A settled future ignores it. */
  reject(reason: unknown): void {
    this.#outcome.open({ status: 'rejected', reason });
  }

  async wait(): Promise<T> {
    const outcome = await this.#outcome.wait();
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  }
}
