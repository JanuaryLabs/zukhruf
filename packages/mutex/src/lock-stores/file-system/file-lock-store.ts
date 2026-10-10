import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { FileTokenSource, type TokenSource } from '@zukhruf/fencing';
import { FileLock, assertLocalDirectory, safeFileName } from '@zukhruf/fs';

import { type LockHandle, leaseFor } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';

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

  async acquire(
    key: string,
    { signal }: AcquireOptions = {},
  ): Promise<LockHandle> {
    signal?.throwIfAborted();
    const held = await this.lock(await this.#prepare(key), signal);
    return leaseFor(key, held, this.#tokens);
  }

  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    const held = await this.tryLock(await this.#prepare(key));
    return held && leaseFor(key, held, this.#tokens);
  }

  /** Makes no directory: a key in a directory that does not exist has no holder. */
  async isHeld(key: string): Promise<boolean> {
    await assertLocalDirectory(this.#directory);
    return this.isHeldAt(this.#pathFor(key));
  }

  /**
   * The length of the longest text this lock store adds to a lock path to
   * name another file for the key. A key whose name would not fit a file name
   * with it gets a shorter name.
   */
  protected abstract readonly longestSuffix: number;

  /** Holds the lock at `path`, waiting for other holders, until `signal` aborts. */
  protected abstract lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable>;

  /** Holds the lock at `path` only if no other holder has it now. */
  protected abstract tryLock(
    path: string,
  ): Promise<AsyncDisposable | undefined>;

  /** Whether the lock at `path` has a holder now, learned without a lock that a caller of `lock` or `tryLock` needs. */
  protected abstract isHeldAt(path: string): Promise<boolean>;

  /** Stops between attempts once `signal` aborts, and then rejects with `signal.reason`. */
  protected async poll<T>(
    attempt: () => Promise<T | undefined>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    for (;;) {
      const result = await attempt();
      if (result !== undefined) return result;
      await untilAborted(
        delay(this.#pollInterval, undefined, { signal }),
        signal,
      );
    }
  }

  /**
   * Serializes evicting a dead holder. Without it, two waiters that saw the
   * same dead holder could each remove a lock the other had just taken. The
   * kernel holds this lock, so a waiter that dies while it evicts frees it at
   * once. Its file stays for the next eviction: deleting it while waiters use
   * it would let two of them lock two different files.
   */
  protected async withReclaimLock(path: string, task: () => Promise<void>) {
    const reclaimPath = `${path}.reclaim`;
    using reclaim = FileLock.open(reclaimPath);
    if (!claim(reclaim, reclaimPath)) return;
    await task();
  }

  async #prepare(key: string): Promise<string> {
    await assertLocalDirectory(this.#directory);
    await mkdir(this.#directory, { recursive: true });
    return this.#pathFor(key);
  }

  #pathFor(key: string): string {
    const name = safeFileName(key, '.lock'.length + this.longestSuffix);
    return join(this.#directory, `${name}.lock`);
  }
}

/** Whether this handle now holds the reclaim lock; another waiter is evicting if not. */
function claim(reclaim: FileLock, path: string): boolean {
  try {
    return reclaim.tryLock();
  } catch (error) {
    if (isNotADatabase(error)) {
      throw new Error(
        `The reclaim file ${JSON.stringify(path)} was left by an older version of @zukhruf/mutex. Stop the processes that run that version, then delete the file.`,
        { cause: error },
      );
    }
    throw error;
  }
}

const SQLITE_NOTADB = 26;

/** Whether `error` means the file is not a SQLite database, for example a file that an older version wrote. */
function isNotADatabase(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === SQLITE_NOTADB
  );
}
