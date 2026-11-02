import { type Clock, timeout } from '@zukhruf/async';

import type { AcquireMode } from '../acquire-mode.ts';
import type { LockHandle } from '../lease.ts';
import type { AcquireOptions, LockStore } from '../lock-store.ts';

export interface SkipIfBusyOptions {
  /**
   * Milliseconds to wait for another holder before giving up. The limit
   * starts when the lock store answers that the key is busy: a slow answer
   * does not show a busy key. Without options, the mode makes one attempt only.
   */
  waitAtMost: number;
  /** The clock that `waitAtMost` runs on: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

/** Gives up when the key stays busy, at once or after `waitAtMost`, so the task may not run. */
export class SkipIfBusyMode implements AcquireMode<'maybe'> {
  readonly outcome = 'maybe' as const;
  readonly #wait: SkipIfBusyOptions | undefined;

  constructor(options?: SkipIfBusyOptions) {
    if (
      options &&
      (!(options.waitAtMost >= 0) || !Number.isFinite(options.waitAtMost))
    ) {
      throw new RangeError(
        `waitAtMost must be a finite number of milliseconds >= 0, got ${options.waitAtMost}.`,
      );
    }
    this.#wait = options;
  }

  async acquire(
    store: LockStore,
    key: string,
    { signal }: AcquireOptions,
  ): Promise<LockHandle | undefined> {
    // Always one attempt first: a time limit must never skip a key that is free.
    const lease = await store.tryAcquire(key);
    if (lease || !this.#wait || this.#wait.waitAtMost === 0) return lease;

    // The caller comes first, so a caller that already cancelled is not read as giving up.
    using limit = timeout(this.#wait.waitAtMost, { clock: this.#wait.clock });
    try {
      return await store.acquire(key, {
        signal: signal ? AbortSignal.any([signal, limit.signal]) : limit.signal,
      });
    } catch (error) {
      if (limit.signal.aborted && error === limit.signal.reason)
        return undefined;
      throw error;
    }
  }
}
