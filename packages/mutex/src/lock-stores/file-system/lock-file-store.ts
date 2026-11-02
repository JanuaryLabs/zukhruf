import { unlink } from 'node:fs/promises';

import type { Clock } from '@zukhruf/async';
import { createExclusive, draftSuffixLength, patiently } from '@zukhruf/fs';

import { Caller } from './caller.ts';
import { FileLockStore } from './file-lock-store.ts';
import { Presence } from './presence.ts';
import { readRecord } from './record-file.ts';

/**
 * Whoever creates the lock file holds the key; releasing deletes it. Waiters
 * retry in no particular order, so this store is not FIFO.
 */
export class LockFileStore extends FileLockStore {
  /** The longer of a presence file and the draft that `createExclusive` writes beside the record. */
  protected readonly longestSuffix = Math.max(
    Presence.suffixLength,
    draftSuffixLength,
  );

  protected lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    const me = Caller.current();
    return this.poll(() => this.#attempt(path, me), signal);
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
    const holder = await readHolder(path, this.clock);
    if (holder) {
      await this.#evictIfGone(path, holder);
      return undefined;
    }

    await using claiming = new AsyncDisposableStack();
    const presence = claiming.adopt(
      Presence.claim(path, me, this.clock),
      (claimed) => claimed.withdraw(),
    );
    if (!(await createExclusive(path, me.serialize(), { clock: this.clock })))
      return undefined;
    claiming.move();
    return {
      [Symbol.asyncDispose]: () =>
        presence.releaseAfter(() => removeLockFile(path, this.clock)),
    };
  }

  /** A gone holder stays: only a caller that acquires evicts it. */
  protected isHeldAt(path: string): Promise<boolean> {
    return Presence.isNamedCallerPresent(path, () =>
      readHolder(path, this.clock),
    );
  }

  async #evictIfGone(path: string, holder: Caller) {
    const state = await Presence.judge(path, holder, () =>
      readHolder(path, this.clock),
    );
    if (state !== 'gone') return;
    await this.withReclaimLock(path, async () => {
      if ((await readHolder(path, this.clock))?.id !== holder.id) return;
      await removeLockFile(path, this.clock);
      await Presence.delete(Presence.pathOf(path, holder), this.clock);
    });
  }
}

function removeLockFile(path: string, clock: Clock) {
  return patiently(() => unlink(path), { clock });
}

async function readHolder(
  path: string,
  clock: Clock,
): Promise<Caller | undefined> {
  const content = await readRecord(path, clock);
  if (content === undefined) return undefined;
  return Caller.parse(content);
}
