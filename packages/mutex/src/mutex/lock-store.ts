import type { Lease } from './lease.ts';

export interface AcquireOptions {
  /** Stops waiting when it aborts; the call then rejects with `signal.reason`. */
  signal?: AbortSignal | undefined;
}

/** Where a mutex keeps its locks; each implementation decides who can share them. */
export interface LockStore {
  /** Resolves once `key` is exclusively held. */
  acquire(key: string, options?: AcquireOptions): Promise<Lease>;
  /** Holds `key` only if that is possible without waiting for another holder. */
  tryAcquire(key: string): Promise<Lease | undefined>;
}
