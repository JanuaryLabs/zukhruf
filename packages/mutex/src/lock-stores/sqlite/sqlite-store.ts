import { FileLock } from '@zukhruf/fs';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions } from '../../mutex/lock-store.ts';
import { InProcessTurns } from '../../shared/in-process-turns.ts';
import { FileLockStore } from '../file-system/file-lock-store.ts';
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
  readonly #turns = new InProcessTurns();

  override acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#turns.acquire(key, options, () => super.acquire(key, options));
  }

  override tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#turns.tryAcquire(key, () => super.tryAcquire(key));
  }

  protected async lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    await using held = new AsyncDisposableStack();
    const lock = held.use(FileLock.open(path));
    await this.poll(async () => (lock.tryLock() ? true : undefined), signal);
    // The release removes the record, then lets the lock go even when the record stays.
    held.use(await new HolderRecord(path).announce());
    return held.move();
  }

  protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
    await using held = new AsyncDisposableStack();
    const lock = held.use(FileLock.open(path));
    if (!lock.tryLock()) return undefined;
    held.use(await new HolderRecord(path).announce());
    return held.move();
  }

  protected isHeldAt(path: string): Promise<boolean> {
    return new HolderRecord(path).isPresent();
  }
}
