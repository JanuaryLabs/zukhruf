import { type AcquireOptions, Semaphore } from './semaphore.ts';

/**
 * Lets one caller at a time hold it: a semaphore of one permit. Callers that
 * wait get the lock in the order in which they came.
 */
export class Lock {
  readonly #semaphore = new Semaphore(1);

  /** Waits in the line for the lock. Dispose the handle to free it: `using held = await lock.acquire(…)`. */
  acquire(options: AcquireOptions): Promise<Disposable> {
    return this.#semaphore.acquire(options);
  }

  /** Gives the lock only when it is free and nobody waits. */
  tryAcquire(): Disposable | undefined {
    return this.#semaphore.tryAcquire();
  }

  /** Holds the lock while `work` runs, and frees it when the work ends, also when the work fails. */
  async run<T>(work: () => Promise<T>, options: AcquireOptions): Promise<T> {
    using _held = await this.acquire(options);
    return await work();
  }
}
