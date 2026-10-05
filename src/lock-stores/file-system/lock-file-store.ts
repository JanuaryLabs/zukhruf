import { readFile, unlink } from 'node:fs/promises';
import { createExclusive } from '../../shared/fs/create-exclusive.ts';
import { isErrno } from '../../shared/fs/errno.ts';
import { FileLockStore } from './file-lock-store.ts';
import { Owner } from './owner.ts';

/**
 * Whoever creates the lock file holds the key; releasing deletes it. Waiters
 * retry in no particular order, so this store is not FIFO.
 */
export class LockFileStore extends FileLockStore {
	protected async lock(path: string): Promise<AsyncDisposable> {
		const me = Owner.current();

		return this.poll(async () => {
			if (await createExclusive(path, me.serialize())) {
				return { [Symbol.asyncDispose]: () => unlink(path) };
			}

			const holder = await readHolder(path);
			if (holder && !holder.isAlive()) {
				await this.withReclaimLock(path, async () => {
					if ((await readHolder(path))?.id === holder.id) await unlink(path);
				});
			}
			return undefined;
		});
	}
}

async function readHolder(path: string): Promise<Owner | undefined> {
	try {
		return Owner.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if (isErrno(error, 'ENOENT')) return undefined;
		throw error;
	}
}
