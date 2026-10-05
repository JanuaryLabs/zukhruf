import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import { leaseFor, type Lease } from '../../mutex/lease.ts';
import type { LockStore } from '../../mutex/lock-store.ts';

export interface MemoryStoreOptions {
	tokens?: TokenSource;
}

/** Per-key FIFO promise chain; locks are shared only through this instance. */
export class MemoryStore implements LockStore {
	readonly #tails = new Map<string, Promise<void>>();
	readonly #tokens: TokenSource;

	constructor({ tokens = new CounterTokenSource() }: MemoryStoreOptions = {}) {
		this.#tokens = tokens;
	}

	async acquire(key: string): Promise<Lease> {
		const previous = this.#tails.get(key);
		const released = Promise.withResolvers<void>();
		const tail = previous
			? previous.then(() => released.promise)
			: released.promise;
		this.#tails.set(key, tail);
		await previous;

		const held = {
			[Symbol.asyncDispose]: async () => {
				released.resolve();
				if (this.#tails.get(key) === tail) this.#tails.delete(key);
			},
		};
		return leaseFor(key, held, this.#tokens);
	}
}
