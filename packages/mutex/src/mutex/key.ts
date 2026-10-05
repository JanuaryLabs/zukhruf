import type { AcquireMode, ModeResult } from './acquire-mode.ts';
import type { Lease } from './lease.ts';
import type { Mutex } from './mutex.ts';

/**
 * A key with the acquire mode that its callers use unless one call says
 * otherwise. Build it with `mutex.key(name, { mode })`.
 */
export class Key<D extends AcquireMode> {
	readonly name: string;
	readonly #mutex: Mutex;
	readonly #mode: D;

	constructor(mutex: Mutex, name: string, mode: D) {
		this.#mutex = mutex;
		this.name = name;
		this.#mode = mode;
	}

	run<T, M extends AcquireMode = D>(
		task: (lease: Lease) => Promise<T>,
		{ mode }: { mode?: M } = {},
	): Promise<ModeResult<M, T>> {
		return this.#mutex.acquire(this.name, task, {
			mode: (mode ?? this.#mode) as M,
		});
	}
}
