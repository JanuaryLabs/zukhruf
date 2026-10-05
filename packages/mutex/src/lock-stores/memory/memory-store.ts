import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import { leaseFor, type Lease } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { untilAborted } from '../../shared/until-aborted.ts';

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

	async acquire(key: string, { signal }: AcquireOptions = {}): Promise<Lease> {
		signal?.throwIfAborted();
		const previous = this.#tails.get(key);
		const released = Promise.withResolvers<void>();
		const tail = previous
			? previous.then(() => released.promise)
			: released.promise;
		this.#tails.set(key, tail);
		const release = async () => {
			released.resolve();
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		};

		const turn = Promise.resolve(previous);
		try {
			await untilAborted(turn, signal);
		} catch (error) {
			// A waiter cannot leave the middle of the chain, so its place passes the key on when its turn comes.
			void turn.then(release);
			throw error;
		}
		return leaseFor(key, { [Symbol.asyncDispose]: release }, this.#tokens);
	}

	async tryAcquire(key: string): Promise<Lease | undefined> {
		if (this.#tails.has(key)) return undefined;
		return this.acquire(key);
	}
}
