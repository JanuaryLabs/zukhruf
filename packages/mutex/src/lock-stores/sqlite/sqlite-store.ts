import { FileLock } from '@zukhruf/fs';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions } from '../../mutex/lock-store.ts';
import { FileLockStore } from '../file-system/file-lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';
import { HolderRecord } from './holder-record.ts';

/**
 * Holds the file lock of the key's database file. The kernel releases it when
 * the holder dies, so a crash never leaves a key locked.
 *
 * Even a read of that file makes it busy for a caller that tries to take it,
 * so the holder also names itself in a holder record, which a look reads
 * instead.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one opens a database connection: one open file per key per process,
 * however many callers wait, and first-come order within the process.
 */
export class SqliteStore extends FileLockStore {
  /**
   * Published versions keep the rollback journal of a key's database at
   * `<path>-journal`. New versions keep it in memory, but a key keeps the file
   * name that those versions gave it, so both versions share its lock. The
   * holder folder `<path>.holder` is shorter.
   */
  protected readonly longestSuffix = '-journal'.length;
  readonly #inProcess = new MemoryStore();

  override async acquire(
    key: string,
    options: AcquireOptions = {},
  ): Promise<LockHandle> {
    // Joining the in-process queue is synchronous, so the order is the order of the calls.
    const turn = await this.#inProcess.acquire(key, options);
    try {
      return withTurn(await super.acquire(key, options), turn);
    } catch (error) {
      await turn[Symbol.asyncDispose]();
      throw error;
    }
  }

  override async tryAcquire(key: string): Promise<LockHandle | undefined> {
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
    using opened = new DisposableStack();
    const lock = opened.use(FileLock.open(path));
    await this.poll(async () => (lock.tryLock() ? true : undefined), signal);
    const held = await holding(path, lock);
    opened.move();
    return held;
  }

  protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
    using opened = new DisposableStack();
    const lock = opened.use(FileLock.open(path));
    if (!lock.tryLock()) return undefined;
    const held = await holding(path, lock);
    opened.move();
    return held;
  }

  protected isHeldAt(path: string): Promise<boolean> {
    return new HolderRecord(path).isPresent();
  }
}

/** Names the holder of the lock. The lock goes however the release of the record goes. */
async function holding(path: string, lock: FileLock): Promise<AsyncDisposable> {
  const record = await new HolderRecord(path).announce();
  return {
    [Symbol.asyncDispose]: async () => {
      try {
        await record[Symbol.asyncDispose]();
      } finally {
        lock[Symbol.dispose]();
      }
    },
  };
}

/** Releases the database lock first, then lets the next caller in this process try. */
function withTurn(handle: LockHandle, turn: AsyncDisposable): LockHandle {
  return {
    token: handle.token,
    signal: handle.signal,
    [Symbol.asyncDispose]: async () => {
      try {
        await handle[Symbol.asyncDispose]();
      } finally {
        await turn[Symbol.asyncDispose]();
      }
    },
  };
}
