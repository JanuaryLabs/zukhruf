import { unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { type Clock, delay } from '@zukhruf/async';
import { DeniedError, UnavailableError } from '@zukhruf/sqlite-open';

import { isErrno } from './errno.ts';
import { FileLock } from './file-lock.ts';
import { PATIENCE, PATIENCE_BACKOFF, patiently } from './patiently.ts';

/**
 * A presence tells other processes that its owner still runs: the owner holds
 * the `FileLock` of a file of its own while it lives, and the kernel frees it
 * when the owner stops, however it stops (ADR 0007). The names come from
 * FreeBSD `pidfile(3)`: `pidfile_open`, `pidfile_remove` and `pidfile_close`.
 *
 * Give each owner a path of its own. Open the file only through `Presence`:
 * on Unix, the close of another descriptor of the file drops the lock.
 */
export class Presence implements Disposable {
  /** The file of the presence. */
  readonly path: string;
  /** Holds the lock until the presence ends. */
  readonly #held: DisposableStack;

  private constructor(path: string, held: DisposableStack) {
    this.path = path;
    this.#held = held;
  }

  /**
   * Opens the file at `path`, creates it when it is absent, and takes its lock.
   * Returns `undefined` at once when another handle holds the lock: another
   * owner, a deleter, or a check for a moment. When the lock is on a file that
   * a deleter removed from the path meanwhile, it opens the new file and tries
   * again.
   */
  static tryOpen(path: string): Presence | undefined {
    for (;;) {
      using opened = new DisposableStack();
      const lock = opened.use(FileLock.open(path));
      if (!lock.tryLock()) return undefined;
      // A deleter that held the lock before this one deleted the file, so the
      // lock is on a file that no reader finds. A check in the process that
      // holds the lock answers locked, and keeps the lock.
      if (FileLock.check(path) === 'locked') {
        return new Presence(path, opened.move());
      }
    }
  }

  /**
   * Whether the owner of the presence at `path` still runs. It reads the file
   * one time, never creates it, and never takes the lock. The answer can be old
   * when you use it.
   */
  static check(path: string): 'present' | 'ended' | 'missing' {
    const state = FileLock.check(path);
    if (state === 'locked') return 'present';
    if (state === 'unlocked') return 'ended';
    return 'missing';
  }

  /**
   * Deletes the file of a presence that ended, while it holds its lock, and
   * never creates the file. Another handle that holds the lock is an owner, a
   * deleter, or a check for a moment; `check` tells them apart. A check is
   * waited out on `clock` for at most 1 second, as `patiently` waits. It
   * resolves `'present'` while an owner or another deleter holds the lock,
   * and `'missing'` when the file is not there.
   */
  static async removeIfEnded(
    path: string,
    { clock }: { clock: Clock },
  ): Promise<'removed' | 'present' | 'missing'> {
    const started = clock.performance.now();
    for (let attempt = 0; ; attempt++) {
      const ended = Presence.#lockExisting(path);
      // The lock can be on a file that another deleter removed from the path
      // meanwhile. A check in this process sees its own lock as present.
      const state = Presence.check(path);
      if (ended && state === 'present') {
        await ended.remove({ clock });
        return 'removed';
      }
      ended?.[Symbol.dispose]();
      if (state === 'missing' || (!ended && state === 'present')) return state;
      if (clock.performance.now() - started > PATIENCE) {
        throw new Error(
          `The presence ${JSON.stringify(path)} has ended, but other processes checked it without a pause for 1 second, so its file stays.`,
        );
      }
      await delay(PATIENCE_BACKOFF.duration(attempt), {
        clock,
        signal: undefined,
      });
    }
  }

  /** The presence of the file at `path` when its lock is free; `undefined` when another handle holds the lock or the file cannot be opened. */
  static #lockExisting(path: string): Presence | undefined {
    using opened = new DisposableStack();
    let lock: FileLock;
    try {
      // SQLite opens a URI with mode=rw to read and write, and never creates
      // the file (https://sqlite.org/uri.html#urimode). The open of a URI
      // cannot tell a missing file from a denied one, so `check` tells it.
      lock = opened.use(FileLock.open(`${pathToFileURL(path).href}?mode=rw`));
    } catch (error) {
      if (error instanceof UnavailableError) return undefined;
      throw error;
    }
    let locked: boolean;
    try {
      locked = lock.tryLock();
    } catch (error) {
      // The error names the URI of the open; the caller passed the path.
      if (error instanceof DeniedError) throw new DeniedError(path, error);
      throw error;
    }
    if (!locked) return undefined;
    return new Presence(path, opened.move());
  }

  /**
   * Ends the presence and deletes its file. On Unix it deletes the file while it
   * holds the lock, then frees the lock, as `pidfile_remove(3)` does: a process
   * that opened the file to lock it then never holds a lock on a file that is
   * gone. On Windows a file that a handle keeps open cannot be deleted, so it
   * frees the lock first, then deletes the file. A refusal while another handle
   * holds the lock leaves the file to that handle; a refusal for a moment is
   * tried again on `clock` for at most 1 second (`patiently`).
   */
  async remove({ clock }: { clock: Clock }): Promise<void> {
    using held = this.#end();
    if (process.platform !== 'win32') {
      await unlinkIfPresent(this.path);
      return;
    }
    held.dispose();
    await patiently(
      async () => {
        try {
          await unlinkIfPresent(this.path);
        } catch (error) {
          if (FileLock.check(this.path) === 'locked') return;
          throw error;
        }
      },
      { clock },
    );
  }

  /** Ends the presence and keeps the file, as `pidfile_close(3)` does. A second disposal does nothing. */
  [Symbol.dispose](): void {
    this.#held.dispose();
  }

  #end(): DisposableStack {
    if (this.#held.disposed) {
      throw new Error(
        `The presence ${JSON.stringify(this.path)} has ended already, so it cannot remove its file.`,
      );
    }
    return this.#held.move();
  }
}

/** A file that somebody deleted by hand is no fault: the presence is gone either way. */
async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}
