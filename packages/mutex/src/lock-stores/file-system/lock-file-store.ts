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
  protected lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    const me = Owner.current();
    return this.poll(() => this.#attempt(path, me), { signal });
  }

  protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
    const me = Owner.current();
    // An attempt that finds a dead holder removes it, so one more attempt can then succeed.
    return (await this.#attempt(path, me)) ?? this.#attempt(path, me);
  }

  async #attempt(
    path: string,
    me: Owner,
  ): Promise<AsyncDisposable | undefined> {
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
