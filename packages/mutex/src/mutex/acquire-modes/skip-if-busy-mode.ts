import type { AcquireMode } from '../acquire-mode.ts';
import type { Lease } from '../lease.ts';
import type { AcquireOptions, LockStore } from '../lock-store.ts';

export interface SkipIfBusyOptions {
  /**
   * Milliseconds to wait for another holder before giving up. The limit
   * starts when the lock store answers that the key is busy: a slow answer
   * does not show a busy key. Defaults to 0: one attempt only.
   */
  waitAtMost?: number;
}

/** Gives up when the key stays busy, at once or after `waitAtMost`, so the task may not run. */
export class SkipIfBusyMode implements AcquireMode<'maybe'> {
  readonly outcome = 'maybe' as const;
  readonly #waitAtMost: number;

  constructor({ waitAtMost = 0 }: SkipIfBusyOptions = {}) {
    if (!(waitAtMost >= 0) || !Number.isFinite(waitAtMost)) {
      throw new RangeError(
        `waitAtMost must be a finite number of milliseconds >= 0, got ${waitAtMost}.`,
      );
    }
    this.#waitAtMost = waitAtMost;
  }

  async acquire(
    store: LockStore,
    key: string,
    { signal }: AcquireOptions,
  ): Promise<Lease | undefined> {
    // Always one attempt first: a time limit must never skip a key that is free.
    const lease = await store.tryAcquire(key);
    if (lease || this.#waitAtMost === 0) return lease;

    // The caller comes first, so a caller that already cancelled is not read as giving up.
    const timeout = AbortSignal.timeout(this.#waitAtMost);
    try {
      return await store.acquire(key, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (timeout.aborted && error === timeout.reason) return undefined;
      throw error;
    }
  }
}
