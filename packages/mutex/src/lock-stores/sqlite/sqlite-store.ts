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
    await using turn = new AsyncDisposableStack();
    // Joining the in-process queue is synchronous, so the order is the order of the calls.
    turn.use(await this.#inProcess.acquire(key, options));
    return withTurn(await super.acquire(key, options), turn);
  }

  override async tryAcquire(key: string): Promise<LockHandle | undefined> {
    await using turn = new AsyncDisposableStack();
    const inProcess = await this.#inProcess.tryAcquire(key);
    if (!inProcess) return undefined;
    turn.use(inProcess);
    const lease = await super.tryAcquire(key);
    return lease && withTurn(lease, turn);
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

/** Releases the database lock first, then lets the next caller in this process try. */
function withTurn(handle: LockHandle, turn: AsyncDisposableStack): LockHandle {
  turn.use(handle);
  const release = turn.move();
  return {
    token: handle.token,
    signal: handle.signal,
    [Symbol.asyncDispose]: () => release.disposeAsync(),
  };
}
