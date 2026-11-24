import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { FileLock, isErrno } from '@zukhruf/fs';
import { MissingError } from '@zukhruf/sqlite-open';

/**
 * A listener's presence: the kernel lock of its own file beside the database,
 * held from before its row is inserted until after its row is removed (ADR
 * 0011). The kernel frees the lock when the listener's process stops, however
 * it stops. So a sender whose connect is refused knows from the lock whether
 * the listener is dead or only accepts nothing now. A copy of the presence of
 * @zukhruf/mutex (docs/copied-code.md, #5463).
 */
export class ListenerPresence {
  readonly #path: string;
  readonly #lock: FileLock;

  private constructor(path: string, lock: FileLock) {
    this.#path = path;
    this.#lock = lock;
  }

  /** The presence file of the listener `id` of the database at `database`: `<database>.listeners/<id>.presence`. */
  static #pathOf(database: string, id: string): string {
    return `${database}.listeners/${id}.presence`;
  }

  /** Takes the presence of a new listener. Its id is new, so no other program knows the file yet. */
  static async take(database: string, id: string): Promise<ListenerPresence> {
    const path = ListenerPresence.#pathOf(database, id);
    await mkdir(dirname(path), { recursive: true });
    using opened = new DisposableStack();
    const lock = opened.use(FileLock.open(path));
    if (!lock.tryLock()) {
      throw new Error(
        `The presence file ${JSON.stringify(path)} is locked already, but it belongs to one listener only. Another program opened it.`,
      );
    }
    opened.move();
    return new ListenerPresence(path, lock);
  }

  /** Whether the listener `id` lives. A listener of an older release has no file, and counts as dead. */
  static check(
    database: string,
    id: string,
  ): 'locked' | 'unlocked' | 'missing' {
    return FileLock.check(ListenerPresence.#pathOf(database, id));
  }

  /** Deletes the presence file of a dead listener, while it holds its lock. A listener of an older release has no file, and maybe no folder. */
  static async removeIfFree(database: string, id: string): Promise<void> {
    const path = ListenerPresence.#pathOf(database, id);
    let lock: FileLock;
    try {
      lock = FileLock.open(path);
    } catch (error) {
      if (error instanceof MissingError) return;
      throw error;
    }
    if (!lock.tryLock()) {
      lock[Symbol.dispose]();
      return;
    }
    await deleteWhileHolding(path, lock);
  }

  /** Deletes the file while it holds the lock, then frees it. */
  async end(): Promise<void> {
    await deleteWhileHolding(this.#path, this.#lock);
  }
}

/**
 * Deletes a presence file whose lock `lock` holds, so a program that opened
 * the file and is about to lock it never keeps a lock on a file that is gone
 * without seeing it. Windows does not delete a file that a handle keeps open,
 * so there the lock is freed first, and a refusal then means that another
 * program opened the file. A copy of `#deleteIfFree` of mutex's
 * `SessionDirectory`.
 */
async function deleteWhileHolding(path: string, lock: FileLock): Promise<void> {
  let refused: boolean;
  {
    using held = lock;
    refused = await unlinkRefused(path);
  }
  if (refused) await unlinkRefused(path);
}

/** Deletes `path`; `true` when Windows refused it because a handle keeps it open. */
async function unlinkRefused(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return false;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    if (isErrno(error, 'EPERM') || isErrno(error, 'EBUSY')) return true;
    throw error;
  }
}
