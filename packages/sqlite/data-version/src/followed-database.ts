import { statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { UnavailableError } from './unavailable-error.ts';

function open(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      // SQLite's CANTOPEN (14). A missing or denied file fails the open()
      // syscall, and SQLite reports that as CANTOPEN, a privacy denial too.
      // SQLite gives AUTH only for an authorizer, and this private connection
      // has none. Any other failure is not one that access can fix.
      cause.errcode === 14
    )
      throw new UnavailableError(path, cause);
    throw cause;
  }
}

// The device and inode of the file at the path, or undefined when this
// process cannot see the path: it is missing, or a folder's mode denies it.
// Bigint, because inode numbers on NTFS and ReFS exceed 2^53.
function identify(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stats === undefined ? undefined : `${stats.dev}:${stats.ino}`;
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'EACCES')
      return undefined;
    throw cause;
  }
}

// One read-only connection and the identity of the file it opened, which
// never change: a replaced file gets a new OpenFile.
class OpenFile implements Disposable {
  readonly identity: string | undefined;
  readonly #database: DatabaseSync;
  readonly #version: StatementSync;

  constructor(path: string) {
    // Stat before open: a file replaced between the two is one extra change
    // at the next observation. Stat after open could give the new file's
    // identity to the old connection, and then the replace is never seen.
    // A path this process cannot see fails the open too, as CANTOPEN.
    this.identity = identify(path);
    this.#database = open(path);
    this.#version = this.#database.prepare('PRAGMA data_version');
  }

  get observation(): string {
    // PRAGMA data_version always gives one row.
    return `${this.identity}|${String(this.#version.get()!.data_version)}`;
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

// A connection keeps reading the file it opened, also after the owner
// replaces the file at the path. This follows the path by name, as tail -F
// does: when the path names a different file, it opens that file.
export class FollowedDatabase implements Disposable {
  readonly #path: string;
  #file: OpenFile;

  constructor(path: string) {
    this.#path = path;
    this.#file = new OpenFile(path);
  }

  // The identity of the held file and its data version. A path this process
  // cannot see keeps the old connection: the owner may be about to create the
  // file again, and the open connection still reads.
  observe(): string {
    const identity = identify(this.#path);
    if (identity !== undefined && identity !== this.#file.identity) {
      // Open the new file before the old one closes. While the old file is
      // open its inode stays in use, so the new file cannot get the same one.
      const file = new OpenFile(this.#path);
      this.#file[Symbol.dispose]();
      this.#file = file;
    }
    return this.#file.observation;
  }

  [Symbol.dispose](): void {
    this.#file[Symbol.dispose]();
  }
}
