import { readFile, unlink } from 'node:fs/promises';

import { createExclusive } from '../../shared/fs/create-exclusive.ts';
import { isErrno } from '../../shared/fs/errno.ts';
import { patiently } from '../../shared/fs/patiently.ts';
import { Caller } from './caller.ts';
import { FileLockStore } from './file-lock-store.ts';
import { Presence } from './presence.ts';

/**
 * Whoever creates the lock file holds the key; releasing deletes it. Waiters
 * retry in no particular order, so this store is not FIFO.
 */
export class LockFileStore extends FileLockStore {
  /** A presence file has the longest name this store makes for a key. */
  protected readonly longestSuffix = Presence.suffixLength;

  protected lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    const me = Caller.current();
    return this.poll(() => this.#attempt(path, me), { signal });
  }

  protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
    const me = Caller.current();
    // An attempt that finds a gone holder removes it, so one more attempt can then succeed.
    return (await this.#attempt(path, me)) ?? this.#attempt(path, me);
  }

  /** A waiter is present only while it tries to create the file, so giving up leaves nothing behind. */
  async #attempt(
    path: string,
    me: Caller,
  ): Promise<AsyncDisposable | undefined> {
    const holder = await readHolder(path);
    if (holder) {
      await this.#evictIfGone(path, holder);
      return undefined;
    }

    const presence = Presence.claim(Presence.pathOf(path, me));
    const created = await createExclusive(path, me.serialize()).catch(
      async (error: unknown) => {
        await presence.withdraw();
        throw error;
      },
    );
    if (!created) {
      await presence.withdraw();
      return undefined;
    }
    return {
      [Symbol.asyncDispose]: () =>
        presence.releaseAfter(() => removeLockFile(path)),
    };
  }

  /** A gone holder stays: only a caller that acquires evicts it. */
  protected isHeldAt(path: string): Promise<boolean> {
    return Presence.isNamedCallerPresent(path, () => readHolder(path));
  }

  async #evictIfGone(path: string, holder: Caller) {
    const state = await Presence.judge(
      path,
      holder,
      async () => (await readHolder(path))?.id === holder.id,
    );
    if (state !== 'gone') return;
    await this.withReclaimLock(path, async () => {
      if ((await readHolder(path))?.id !== holder.id) return;
      await removeLockFile(path);
      await Presence.delete(Presence.pathOf(path, holder));
    });
  }
}

function removeLockFile(path: string) {
  return patiently(() => unlink(path));
}

async function readHolder(path: string): Promise<Caller | undefined> {
  try {
    return Caller.parse(await patiently(() => readFile(path, 'utf8')));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}
