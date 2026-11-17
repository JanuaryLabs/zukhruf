import { untilAborted } from './until-aborted.ts';

export interface AcquireOptions {
  /** Cancels the wait: the caller leaves the line, and the acquire rejects with `signal.reason`. */
  signal: AbortSignal | undefined;
}

/**
 * Lets at most `permits` callers hold a permit at the same time. A caller
 * that finds no free permit waits in a line, and the permits go to the line
 * in the order in which the callers came. A dispose of a permit gives it to
 * the first waiter, so a later caller never takes it first.
 */
export class Semaphore {
  #free: number;
  /** The turns of the waiters, first in line first. A dispose calls the first one. */
  readonly #line: (() => void)[] = [];
  /** The permits that holders have not disposed yet, so a second dispose of one permit frees nothing. */
  readonly #held = new Set<Disposable>();

  constructor(permits: number) {
    if (!(Number.isInteger(permits) && permits > 0))
      throw new RangeError(
        `permits must be a positive integer, not ${permits}`,
      );
    this.#free = permits;
  }

  /**
   * Gives a permit when one is free, or waits in the line for one. Dispose
   * the permit to give it back: `using permit = await semaphore.acquire(…)`.
   * When the signal aborts, also before the call, the caller takes no permit.
   */
  async acquire({ signal }: AcquireOptions): Promise<Disposable> {
    signal?.throwIfAborted();
    const free = this.tryAcquire();
    if (free) return free;
    const turn = Promise.withResolvers<void>();
    this.#line.push(turn.resolve);
    try {
      await untilAborted(turn.promise, signal);
    } catch (error) {
      const place = this.#line.indexOf(turn.resolve);
      // The turn came in the same step as the cancel: the permit passes on.
      if (place === -1) this.#release();
      else this.#line.splice(place, 1);
      throw error;
    }
    return this.#permit();
  }

  /** Gives a permit only when one is free, which is never while callers wait in the line. */
  tryAcquire(): Disposable | undefined {
    if (this.#free === 0) return undefined;
    this.#free--;
    return this.#permit();
  }

  #permit(): Disposable {
    const permit: Disposable = {
      [Symbol.dispose]: () => {
        if (this.#held.delete(permit)) this.#release();
      },
    };
    this.#held.add(permit);
    return permit;
  }

  #release(): void {
    const next = this.#line.shift();
    if (next) next();
    else this.#free++;
  }
}
