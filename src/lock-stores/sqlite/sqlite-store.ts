import { DatabaseSync } from 'node:sqlite';
import type { Lease } from '../../mutex/lease.ts';
import type { AcquireOptions } from '../../mutex/lock-store.ts';
import { isBusy } from '../../shared/sqlite/is-busy.ts';
import { FileLockStore } from '../file-system/file-lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';

/**
 * Holds an exclusive SQLite transaction on the key's database file. SQLite
 * locks through the kernel, which releases them when the holder dies, so a
 * crash never leaves a key locked. Keep the default rollback journal: in WAL
 * mode an exclusive transaction no longer blocks readers.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one opens a database connection: one open file per key per process,
 * however many callers wait, and first-come order within the process.
 */
export class SqliteStore extends FileLockStore {
	readonly #inProcess = new MemoryStore();

	async acquire(key: string, options: AcquireOptions = {}): Promise<Lease> {
		// Joining the in-process queue is synchronous, so the order is the order of the calls.
		const turn = await this.#inProcess.acquire(key, options);
		try {
			return withTurn(await super.acquire(key, options), turn);
		} catch (error) {
			await turn[Symbol.asyncDispose]();
			throw error;
		}
	}

	async tryAcquire(key: string): Promise<Lease | undefined> {
		const turn = await this.#inProcess.tryAcquire(key);
		if (!turn) return undefined;
		try {
			const lease = await super.tryAcquire(key);
			if (lease) return withTurn(lease, turn);
		} catch (error) {
			await turn[Symbol.asyncDispose]();
			throw error;
		}
		await turn[Symbol.asyncDispose]();
		return undefined;
	}

	protected async lock(
		path: string,
		signal: AbortSignal | undefined,
	): Promise<AsyncDisposable> {
		const database = new DatabaseSync(path, { timeout: 0 });
		try {
			await this.poll(async () => (begin(database) ? true : undefined), { signal });
		} catch (error) {
			database.close();
			throw error;
		}
		return holding(database);
	}

	protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
		const database = new DatabaseSync(path, { timeout: 0 });
		try {
			if (begin(database)) return holding(database);
		} catch (error) {
			database.close();
			throw error;
		}
		database.close();
		return undefined;
	}
}

/** Starts the exclusive transaction, or reports that another connection holds it. */
function begin(database: DatabaseSync): boolean {
	try {
		database.exec('BEGIN EXCLUSIVE');
		return true;
	} catch (error) {
		if (isBusy(error)) return false;
		throw error;
	}
}

function holding(database: DatabaseSync): AsyncDisposable {
	return {
		[Symbol.asyncDispose]: async () => {
			database.exec('ROLLBACK');
			database.close();
		},
	};
}

/** Releases the database lock first, then lets the next caller in this process try. */
function withTurn(lease: Lease, turn: AsyncDisposable): Lease {
	return {
		token: lease.token,
		[Symbol.asyncDispose]: async () => {
			try {
				await lease[Symbol.asyncDispose]();
			} finally {
				await turn[Symbol.asyncDispose]();
			}
		},
	};
}
