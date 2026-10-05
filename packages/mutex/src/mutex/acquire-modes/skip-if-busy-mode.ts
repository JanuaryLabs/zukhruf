import type { AcquireMode } from '../acquire-mode.ts';
import type { Lease } from '../lease.ts';
import type { LockStore } from '../lock-store.ts';

export interface SkipIfBusyOptions {
  /** Milliseconds to wait for a busy key before giving up. Defaults to 0: one attempt only. */
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

  async acquire(store: LockStore, key: string): Promise<Lease | undefined> {
    // Always one attempt first: a time limit must never skip a key that is free.
    const lease = await store.tryAcquire(key);
    if (lease || this.#waitAtMost === 0) return lease;

    const signal = AbortSignal.timeout(this.#waitAtMost);
    try {
      return await store.acquire(key, { signal });
    } catch (error) {
      if (error === signal.reason) return undefined;
      throw error;
    }
  }
}
