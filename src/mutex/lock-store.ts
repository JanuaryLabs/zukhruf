import type { Lease } from './lease.ts';

/** Where a mutex keeps its locks; each implementation decides who can share them. */
export interface LockStore {
	/** Resolves once `key` is exclusively held. */
	acquire(key: string): Promise<Lease>;
}
