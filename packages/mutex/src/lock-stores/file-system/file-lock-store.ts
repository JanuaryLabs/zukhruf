import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FileTokenSource } from '../../fencing/file-token-source.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import { leaseFor, type Lease } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { createExclusive } from '../../shared/fs/create-exclusive.ts';
import { safeFileName } from '../../shared/fs/safe-file-name.ts';
import { Owner } from './owner.ts';

export interface FileLockStoreOptions {
	/** Milliseconds a waiter sleeps between attempts. */
	pollInterval?: number;
	/** Defaults to durable per-key counter files beside the locks. */
	tokens?: TokenSource;
}

export interface PollOptions {
	/** Stops between attempts when it aborts; the poll then rejects with `signal.reason`. */
	signal?: AbortSignal | undefined;
	/** Whether the wait between attempts keeps the process alive. */
	keepAlive?: boolean;
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

	async acquire(key: string, { signal }: AcquireOptions = {}): Promise<Lease> {
		signal?.throwIfAborted();
		const held = await this.lock(await this.#pathFor(key), signal);
		return leaseFor(key, held, this.#tokens);
	}

	async tryAcquire(key: string): Promise<Lease | undefined> {
		const held = await this.tryLock(await this.#pathFor(key));
		return held && leaseFor(key, held, this.#tokens);
	}

	/** Holds the lock at `path`, waiting for other holders, until `signal` aborts. */
	protected abstract lock(
		path: string,
		signal: AbortSignal | undefined,
	): Promise<AsyncDisposable>;

	/** Holds the lock at `path` only if no other holder has it now. */
	protected abstract tryLock(path: string): Promise<AsyncDisposable | undefined>;

	protected async poll<T>(
		attempt: () => Promise<T | undefined>,
		{ signal, keepAlive = true }: PollOptions = {},
	): Promise<T> {
		for (;;) {
			const result = await attempt();
			if (result !== undefined) return result;
			try {
				await delay(this.#pollInterval, undefined, { signal, ref: keepAlive });
			} catch (error) {
				signal?.throwIfAborted();
				throw error;
			}
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

	async #pathFor(key: string): Promise<string> {
		await mkdir(this.#directory, { recursive: true });
		return join(this.#directory, `${safeFileName(key)}.lock`);
	}
}
