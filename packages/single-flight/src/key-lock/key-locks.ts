import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { poll } from '@zukhruf/async';
import { FileLock } from '@zukhruf/fs';

/**
 * The kernel locks on the keys of one flight directory. The process that runs
 * a key's work holds that key's lock, so the kernel keeps the key while the
 * process lives, frozen or not, and frees it when the process dies.
 *
 * Each key has the file `execution-locks/<sha256 of the key>.lock`. The folder
 * keeps the key `flight` away from the election's `flight.lock`. The digest
 * keeps keys that differ only in case apart: APFS and NTFS treat `Sync` and
 * `sync` as one file name. The files are never deleted: one per key ever led.
 */
export class KeyLocks {
  readonly #folder: string;
  readonly #pollInterval: number;

  constructor(directory: string, pollInterval: number) {
    this.#folder = join(directory, 'execution-locks');
    this.#pollInterval = pollInterval;
  }

  /**
   * Holds the lock of `key` until the result is disposed. The first try is
   * synchronous, in the call; while another handle holds the lock, it tries
   * again every poll interval. An abort closes the handle and rejects with
   * `signal.reason`. A file fault rejects.
   */
  async acquire(key: string, signal: AbortSignal): Promise<Disposable> {
    // A lead answer comes only after a connection, so the directory passed the local check.
    mkdirSync(this.#folder, { recursive: true });
    using opened = new DisposableStack();
    const lock = opened.use(FileLock.open(this.#pathOf(key)));
    await poll(async () => (lock.tryLock() ? lock : undefined), {
      interval: this.#pollInterval,
      signal,
    });
    opened.move();
    return lock;
  }

  /**
   * Whether a process holds the lock of `key` now. The answer can be stale as
   * soon as it returns, and the check briefly takes a shared lock, so a
   * `tryLock` at that moment fails once. A file fault throws.
   */
  isHeld(key: string): boolean {
    return FileLock.check(this.#pathOf(key)) === 'locked';
  }

  /**
   * Resolves `true` once no process holds the lock of `key`, and `false` once
   * `wanted` answers false. Both are checked every poll interval, on a timer
   * that never keeps the process alive. An abort rejects with
   * `signal.reason`, and a file fault rejects.
   */
  whenFree(
    key: string,
    wanted: () => boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    return poll(
      async () => {
        if (!wanted()) return false;
        return this.isHeld(key) ? undefined : true;
      },
      { interval: this.#pollInterval, signal, ref: false },
    );
  }

  #pathOf(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return join(this.#folder, `${digest}.lock`);
  }
}
