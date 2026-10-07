import type { LockHandle } from './lease.ts';

export interface AcquireOptions {
  /** Stops waiting when it aborts; the call then rejects with `signal.reason`. */
  signal?: AbortSignal | undefined;
}

/** Where a mutex keeps its locks; each implementation decides who can share them. */
export interface LockStore {
  /** Resolves once `key` is exclusively held. */
  acquire(key: string, options?: AcquireOptions): Promise<LockHandle>;
  /** Holds `key` only if that is possible without waiting for another holder. */
  tryAcquire(key: string): Promise<LockHandle | undefined>;
  /**
   * Whether `key` has a holder now. The answer never acquires the key, so it
   * never competes with a caller that acquires it. The holder can change
   * before the answer arrives: show the answer, but never decide from it to
   * acquire the key; an acquire mode decides that.
   */
  isHeld(key: string): Promise<boolean>;
}
