import { randomUUID } from 'node:crypto';
import { FencingToken } from '../../fencing/fencing-token.ts';
import type { Lease } from '../../mutex/lease.ts';
import { LockLostError } from '../../mutex/lock-lost-error.ts';
import type { LockStore } from '../../mutex/lock-store.ts';
import type { ClientConnection, Connector } from './connector.ts';
import { CoordinatorUnavailableError } from './coordinator-unavailable-error.ts';
import type { LockRequest, LockResponse } from './protocol.ts';

interface Pending {
	key: string;
	granted: PromiseWithResolvers<FencingToken>;
}

interface Held {
	key: string;
	token: FencingToken;
}

/**
 * Asks a coordinator for keys over a connection. When the connection drops, it
 * asks its connector for another, reasserts the keys it holds and re-requests
 * the ones it waits for. A held key whose reassertion is refused is lost.
 */
export class RemoteLockClient implements LockStore {
	readonly #connector: Connector;
	readonly #pending = new Map<string, Pending>();
	readonly #held = new Map<string, Held>();
	readonly #lost = new Set<string>();
	#connection: Promise<ClientConnection | undefined> | undefined;
	#current: ClientConnection | undefined;
	#closed = false;

	constructor(connector: Connector) {
		this.#connector = connector;
	}

	async acquire(key: string): Promise<Lease> {
		if (this.#closed) throw new Error('This lock client is closed.');
		const id = randomUUID();
		const granted = Promise.withResolvers<FencingToken>();
		this.#pending.set(id, { key, granted });
		this.#updateRef();
		try {
			this.#connection ??= this.#open();
			const connection = await this.#connection;
			if (!connection) throw new CoordinatorUnavailableError(key);
			void this.#send(connection, { op: 'acquire', id, key });
			const token = await granted.promise;
			this.#held.set(id, { key, token });
			return this.#lease(id, key, token);
		} finally {
			this.#pending.delete(id);
			this.#updateRef();
		}
	}

	#lease(id: string, key: string, token: FencingToken): Lease {
		return {
			token,
			[Symbol.asyncDispose]: async () => {
				// Forget the key first, so a reconnect cannot reassert a released lease.
				const wasHeld = this.#held.delete(id);
				if (this.#lost.delete(id)) throw new LockLostError(key);
				if (wasHeld && this.#current) {
					await this.#send(this.#current, { op: 'release', id });
				}
			},
		};
	}

	async #open(): Promise<ClientConnection | undefined> {
		const connection = await this.#connector.connect();
		if (!connection) {
			this.#connection = undefined;
			return undefined;
		}
		this.#current = connection;
		connection.listen({
			message: (response) => this.#receive(response),
			close: () => this.#reconnect(connection),
		});
		this.#updateRef();
		return connection;
	}

	#receive(response: LockResponse) {
		if (response.op === 'granted') {
			this.#pending
				.get(response.id)
				?.granted.resolve(new FencingToken(BigInt(response.token)));
		} else if (this.#held.delete(response.id)) {
			this.#lost.add(response.id);
		}
	}

	async #send(connection: ClientConnection, request: LockRequest) {
		try {
			await connection.send(request);
		} catch {
			this.#reconnect(connection);
		}
	}

	/** Disconnects for good; the coordinator releases whatever this client still holds. */
	close() {
		this.#closed = true;
		const current = this.#current;
		this.#current = undefined;
		current?.close();
	}

	#reconnect(lost: ClientConnection) {
		if (this.#closed || this.#current !== lost) return;
		this.#current = undefined;
		lost.close();
		this.#connection = this.#open();
		void this.#connection.then((connection) => this.#resume(connection));
	}

	async #resume(connection: ClientConnection | undefined) {
		if (!connection) {
			// Held keys stay exclusive: no coordinator is left to grant them to anyone else.
			for (const { key, granted } of this.#pending.values()) {
				granted.reject(new CoordinatorUnavailableError(key));
			}
			return;
		}
		for (const [id, { key, token }] of this.#held) {
			await this.#send(connection, {
				op: 'reassert',
				id,
				key,
				token: token.toString(),
			});
		}
		for (const [id, { key }] of this.#pending) {
			await this.#send(connection, { op: 'acquire', id, key });
		}
	}

	#updateRef() {
		if (this.#pending.size > 0) this.#current?.ref();
		else this.#current?.unref();
	}
}
