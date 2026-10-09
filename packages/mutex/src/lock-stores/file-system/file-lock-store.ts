import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { FileTokenSource, type TokenSource } from '@zukhruf/fencing';
import { assertLocalDirectory, safeFileName } from '@zukhruf/fs';

import { type LockHandle, leaseFor } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { isBusy } from '../../shared/sqlite/is-busy.ts';
import { isNotADatabase } from '../../shared/sqlite/is-not-a-database.ts';

export interface FileLockStoreOptions {
  /** Milliseconds a waiter sleeps between attempts. */
  pollInterval?: number;
  /** Defaults to durable per-key counter files beside the locks. */
  tokens?: TokenSource;
}

export interface PollOptions {
  /** Stops between attempts when it aborts; the poll then rejects with `signal.reason`. */
  signal?: AbortSignal | undefined;
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

  protected async poll<T>(
    attempt: () => Promise<T | undefined>,
    { signal }: PollOptions = {},
  ): Promise<T> {
    for (;;) {
      const result = await attempt();
      if (result !== undefined) return result;
      try {
        await delay(this.#pollInterval, undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }

  /**
   * Serializes evicting a dead holder. Without it, two waiters that saw the
   * same dead holder could each remove a lock the other had just taken. The
   * kernel holds this lock, so a waiter that dies while it evicts frees it at
   * once. Its file stays for the next eviction: deleting it while waiters use
   * it would let two of them lock two different files. Nothing may open that
   * file except through SQLite: closing any other handle to it drops this
   * process's lock without a word.
   */
  protected async withReclaimLock(path: string, task: () => Promise<void>) {
    const reclaimPath = `${path}.reclaim`;
    const reclaim = new DatabaseSync(reclaimPath, { timeout: 0 });
    try {
      if (!claim(reclaim, reclaimPath)) return;
      try {
        await task();
      } finally {
        reclaim.exec('ROLLBACK');
      }
    } finally {
      reclaim.close();
    }
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

/** Whether this connection now holds the reclaim lock; another waiter is evicting if not. */
function claim(reclaim: DatabaseSync, path: string): boolean {
  try {
    // A journal on disk would outlive a waiter that dies while it holds the lock.
    reclaim.exec('PRAGMA journal_mode = MEMORY');
    reclaim.exec('BEGIN EXCLUSIVE');
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    if (isNotADatabase(error)) {
      throw new Error(
        `The reclaim file ${JSON.stringify(path)} was left by an older version of @zukhruf/mutex. Stop the processes that run that version, then delete the file.`,
        { cause: error },
      );
    }
    throw error;
  }
}
