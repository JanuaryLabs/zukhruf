import { statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { UnavailableError } from './data-version.ts';

function open(path: string, unavailable: UnavailableError): DatabaseSync {
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
      throw new unavailable(path, cause);
    throw cause;
  }
}

// The device and inode of the file at the path, or undefined when the path
// names no file. Bigint, because inode numbers on NTFS and ReFS exceed 2^53.
function identify(path: string): string | undefined {
  const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stats === undefined ? undefined : `${stats.dev}:${stats.ino}`;
}

// A connection keeps reading the file it opened, also after the owner
// replaces the file at the path. This follows the path by name, as tail -F
// does: when the path names a different file, it opens that file.
export class FollowedDatabase implements Disposable {
  readonly #path: string;
  readonly #unavailable: UnavailableError;
  #identity: string;
  #database: DatabaseSync;
  #version: StatementSync;

  constructor(path: string, unavailable: UnavailableError) {
    this.#path = path;
    this.#unavailable = unavailable;
    // Stat before open: a file replaced between the two is one extra change
    // at the next observation. Stat after open could give the new file's
    // identity to the old connection, and then the replace is never seen.
    let identity: string | undefined;
    try {
      identity = identify(path);
    } catch (cause) {
      // A folder whose mode denies this process. SQLite reported it as
      // CANTOPEN when the open came first.
      if (cause instanceof Error && 'code' in cause && cause.code === 'EACCES')
        throw new unavailable(path, cause);
      throw cause;
    }
    this.#database = open(path, unavailable);
    this.#identity = identity ?? '';
    this.#version = this.#database.prepare('PRAGMA data_version');
  }

  // The identity of the held file and its data version. A missing path keeps
  // the old connection: the owner may be about to create the file again.
  observe(): string {
    const identity = identify(this.#path);
    if (identity !== undefined && identity !== this.#identity) {
      // Open the new file before the old one closes. While the old file is
      // open its inode stays in use, so the new file cannot get the same one.
      const database = open(this.#path, this.#unavailable);
      this.#database.close();
      this.#database = database;
      this.#identity = identity;
      this.#version = database.prepare('PRAGMA data_version');
    }
    return `${this.#identity}|${String(this.#version.get()?.data_version)}`;
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
