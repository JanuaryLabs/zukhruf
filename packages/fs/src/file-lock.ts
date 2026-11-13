import type { DatabaseSync } from 'node:sqlite';

import { MissingError, UnchangedJournal, open } from '@zukhruf/sqlite-open';

const SQLITE_BUSY = 5;

/** Garbage collection closes a connection that nobody references, and a lock that it holds goes with it. */
const held = new Set<DatabaseSync>();

/**
 * A lock on a file that the kernel holds: an exclusive SQLite transaction on
 * the file. The kernel frees it when the holder's process dies, however it
 * dies, so a crash never leaves the file locked.
 *
 * On Unix the lock is a POSIX record lock, which the kernel ties to the
 * process and the file. Closing any other descriptor of the file in this
 * process drops the lock without a word, so open the file only through
 * `FileLock`. A network file system does not share the lock reliably between
 * machines: check the directory with `assertLocalDirectory` first.
 */
export class FileLock implements Disposable {
  readonly #path: string;
  readonly #database: DatabaseSync;

  private constructor(path: string, database: DatabaseSync) {
    this.#path = path;
    this.#database = database;
  }

  /** Opens the file, and creates it empty when it is absent. Takes no lock. */
  static open(path: string): FileLock {
    // No busy timeout: one above zero blocks the event loop while it waits, so
    // a caller tries again instead. The open does not set the journal: that
    // statement waits for the lock of the file, so each `tryLock` sets it.
    return new FileLock(
      path,
      open(path, { journal: new UnchangedJournal(), timeout: 0 }),
    );
  }

  /**
   * Whether a handle holds the lock on the file at `path` now. It reads
   * the file once, read-only, and never creates it. For that read it takes a
   * shared lock, so a `tryLock` at that moment can return `false`. The answer
   * can be stale as soon as it returns.
   */
  static check(path: string): 'locked' | 'unlocked' | 'missing' {
    let database: DatabaseSync;
    try {
      database = open(path, { readOnly: true, timeout: 0 });
    } catch (error) {
      if (error instanceof MissingError) return 'missing';
      // A file that exists but cannot be opened is a fault, not a missing
      // file: it surfaces as the UnavailableError of the open.
      throw error;
    }
    try {
      database.prepare('SELECT count(*) FROM sqlite_schema').get();
      return 'unlocked';
    } catch (error) {
      if (hasResultCode(error, SQLITE_BUSY)) return 'locked';
      throw error;
    } finally {
      database.close();
    }
  }

  /** Takes the lock without waiting. Returns `false` when another handle holds it. */
  tryLock(): boolean {
    if (this.#database.isTransaction) {
      throw new Error(
        `This handle holds the file lock ${JSON.stringify(this.#path)} already.`,
      );
    }
    try {
      // A journal on disk would outlive a holder that dies. The statement is
      // busy too while another handle holds the lock, so each try runs it.
      this.#database.exec('PRAGMA journal_mode = MEMORY');
      this.#database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (hasResultCode(error, SQLITE_BUSY)) return false;
      throw error;
    }
    held.add(this.#database);
    return true;
  }

  /** Lets the lock go. The handle stays open for the next `tryLock`. */
  unlock(): void {
    if (!this.#database.isTransaction) {
      throw new Error(
        `This handle does not hold the file lock ${JSON.stringify(this.#path)}.`,
      );
    }
    this.#database.exec('ROLLBACK');
    held.delete(this.#database);
  }

  /** Closes the handle. A lock that it holds goes with it. */
  [Symbol.dispose](): void {
    held.delete(this.#database);
    this.#database[Symbol.dispose]();
  }
}

/** The low byte of SQLite's extended result code is the primary code, so this covers each variant of `code`. */
function hasResultCode(error: unknown, code: number): boolean {
  return (
    Error.isError(error) &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === code
  );
}
