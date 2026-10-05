import type { Lease } from './lease.ts';
import type { LockStore } from './lock-store.ts';

export class Mutex {
	readonly #store: LockStore;

	constructor(store: LockStore) {
		this.#store = store;
	}

	async acquire<T>(key: string, task: (lease: Lease) => Promise<T>): Promise<T> {
		await using lease = await this.#store.acquire(key);
		return await task(lease);
	}
}
