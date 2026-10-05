import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FileTokenSource } from '../../fencing/file-token-source.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import { leaseFor, type Lease } from '../../mutex/lease.ts';
import type { LockStore } from '../../mutex/lock-store.ts';
import { createExclusive } from '../../shared/fs/create-exclusive.ts';
import { safeFileName } from '../../shared/fs/safe-file-name.ts';
import { Owner } from './owner.ts';

export interface FileLockStoreOptions {
	/** Milliseconds a waiter sleeps between attempts. */
	pollInterval?: number;
	/** Defaults to durable per-key counter files beside the locks. */
	tokens?: TokenSource;
}

/** Shares one lock directory between processes: each key maps to `<directory>/<key>.lock`. */
export abstract class FileLockStore implements LockStore {
	readonly #directory: string;
	readonly #pollInterval: number;
	readonly #tokens: TokenSource;

	constructor(
		directory: string,
		{
			pollInterval = 10,
			tokens = new FileTokenSource(directory),
		}: FileLockStoreOptions = {},
	) {
		this.#directory = directory;
		this.#pollInterval = pollInterval;
		this.#tokens = tokens;
	}

	async acquire(key: string): Promise<Lease> {
		await mkdir(this.#directory, { recursive: true });
		const held = await this.lock(
			join(this.#directory, `${safeFileName(key)}.lock`),
		);
		return leaseFor(key, held, this.#tokens);
	}

	protected abstract lock(path: string): Promise<AsyncDisposable>;

	protected async poll<T>(attempt: () => Promise<T | undefined>): Promise<T> {
		for (;;) {
			const result = await attempt();
			if (result !== undefined) return result;
			await delay(this.#pollInterval);
		}
	}

	/**
	 * Serializes evicting a dead holder. Without it, two waiters that saw the
	 * same dead holder could each remove a lock the other had just taken.
	 * A process dying inside `task` leaves `<path>.reclaim` behind, which then
	 * has to be removed by hand.
	 */
	protected async withReclaimLock(path: string, task: () => Promise<void>) {
		const reclaim = `${path}.reclaim`;
		if (!(await createExclusive(reclaim, Owner.current().serialize()))) return;
		try {
			await task();
		} finally {
			await unlink(reclaim);
		}
	}
}
