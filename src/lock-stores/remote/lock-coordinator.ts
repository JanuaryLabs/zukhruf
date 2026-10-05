import { setTimeout as delay } from 'node:timers/promises';
import { FencingToken } from '../../fencing/fencing-token.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import type { Lease } from '../../mutex/lease.ts';
import type { LockStore } from '../../mutex/lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';
import type { Connection } from './connection.ts';
import type { LockRequest, LockResponse } from './protocol.ts';

export interface LockCoordinatorOptions {
	tokens: TokenSource;
	/**
	 * Milliseconds after start during which nothing is granted, so holders from a
	 * previous coordinator can reassert their keys first. Zero for a coordinator
	 * that never replaces another.
	 */
	graceWindow?: number;
}

interface Reassertion {
	token: FencingToken;
	lease: Promise<Lease>;
	lose(): void;
}

/**
 * Grants keys in FIFO order to its own callers and to peers it serves over
 * connections. A peer that disconnects releases everything it held or waited for.
 */
export class LockCoordinator implements LockStore {
	readonly #store: MemoryStore;
	readonly #graceOver: Promise<void>;
	readonly #reassertions = new Map<string, Reassertion>();
	#inGrace: boolean;

	constructor({ tokens, graceWindow = 0 }: LockCoordinatorOptions) {
		this.#store = new MemoryStore({ tokens });
		this.#inGrace = graceWindow > 0;
		this.#graceOver = this.#inGrace
			? delay(graceWindow, undefined, { ref: false }).then(() => {
					this.#inGrace = false;
					this.#reassertions.clear();
				})
			: Promise.resolve();
	}

	async acquire(key: string): Promise<Lease> {
		await this.#graceOver;
		return this.#store.acquire(key);
	}

	serve(connection: Connection<LockResponse, LockRequest>): void {
		new Session(this, connection);
	}

	/**
	 * Re-registers a holder from before a failover. Accepted only during the
	 * grace window; for two claims on one key the newer token wins and the older
	 * claim's `lose` is called. Resolves `undefined` when the claim is refused.
	 */
	reassert(
		key: string,
		token: FencingToken,
		lose: () => void,
	): Promise<Lease> | undefined {
		if (!this.#inGrace) return undefined;
		const existing = this.#reassertions.get(key);
		if (existing && !token.isNewerThan(existing.token)) return undefined;

		existing?.lose();
		// Nothing is granted during grace, so the first claim gets the key at once
		// and a newer claim takes over that same lease.
		const lease = existing?.lease ?? this.#store.acquire(key);
		this.#reassertions.set(key, { token, lease, lose });
		return lease;
	}
}

class Session {
	readonly #coordinator: LockCoordinator;
	readonly #connection: Connection<LockResponse, LockRequest>;
	readonly #leases = new Map<string, Lease>();
	readonly #requested = new Set<string>();
	readonly #lost = new Set<string>();
	#closed = false;

	constructor(
		coordinator: LockCoordinator,
		connection: Connection<LockResponse, LockRequest>,
	) {
		this.#coordinator = coordinator;
		this.#connection = connection;
		connection.listen({
			message: (request) => {
				this.#handle(request).catch(() => connection.close());
			},
			close: () => {
				void this.#close();
			},
		});
	}

	async #handle(request: LockRequest) {
		switch (request.op) {
			case 'acquire': {
				// A reconnecting client may resend a request; granting it twice would orphan one lease.
				if (this.#requested.has(request.id)) return;
				this.#requested.add(request.id);
				const lease = await this.#coordinator.acquire(request.key);
				if (this.#closed) return lease[Symbol.asyncDispose]();
				this.#leases.set(request.id, lease);
				return this.#reply({
					op: 'granted',
					id: request.id,
					token: lease.token.toString(),
				});
			}
			case 'release': {
				const lease = this.#leases.get(request.id);
				this.#leases.delete(request.id);
				this.#requested.delete(request.id);
				return lease?.[Symbol.asyncDispose]();
			}
			case 'reassert': {
				const claim = this.#coordinator.reassert(
					request.key,
					new FencingToken(BigInt(request.token)),
					() => this.#lose(request.id),
				);
				if (!claim) return this.#reply({ op: 'rejected', id: request.id });
				const lease = await claim;
				if (this.#lost.has(request.id)) return;
				if (this.#closed) return lease[Symbol.asyncDispose]();
				this.#leases.set(request.id, lease);
				return;
			}
		}
	}

	/** A newer claim took this session's reasserted lease over, so it must not release it. */
	#lose(id: string) {
		this.#lost.add(id);
		this.#leases.delete(id);
		void this.#reply({ op: 'rejected', id });
	}

	async #reply(response: LockResponse) {
		// A failed send means the peer is gone; `close` then releases its leases.
		await this.#connection.send(response).catch(() => {});
	}

	async #close() {
		this.#closed = true;
		const leases = [...this.#leases.values()];
		this.#leases.clear();
		for (const lease of leases) await lease[Symbol.asyncDispose]();
	}
}
