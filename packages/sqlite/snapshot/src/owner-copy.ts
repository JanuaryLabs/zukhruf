import { constants, rmSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FileStamps, isErrno } from '@zukhruf/fs';
import { UnavailableError } from '@zukhruf/sqlite-reader';

import { DatabaseChangingError } from './database-changing-error.ts';

// Tries at once, without a wait: a commit writes the journal and the database
// with syncs between them, so the next copy lands in a quiet moment.
const attempts = 5;

// A missing file, or one this process may not read: EACCES for its mode,
// EPERM for the privacy controls of macOS.
const unreadable = (error: unknown) =>
  ['ENOENT', 'EACCES', 'EPERM'].some((code) => isErrno(error, code));

// A clone where the file system can make one, as APFS and Btrfs can: it takes
// no time and no space. Elsewhere, a copy of the bytes.
const clone = (from: string, to: string) =>
  copyFile(from, to, constants.COPYFILE_FICLONE);

/**
 * A private copy of a database whose owner holds SQLite's exclusive locking
 * mode, at the last commit of the owner. The copy holds the database and its
 * rollback journal as they were at one moment: the stamps of both files are
 * the same before and after the copy, so the owner wrote neither while it was
 * taken. Opened once for writing, SQLite rolls back a hot journal in the
 * copy, never in the owner's files.
 */
export class OwnerCopy implements Disposable {
  readonly file: string;
  readonly #folder: string;

  private constructor(folder: string, file: string) {
    this.#folder = folder;
    this.file = file;
  }

  static async take(path: string): Promise<OwnerCopy> {
    const folder = await mkdtemp(join(tmpdir(), 'zukhruf-snapshot-'));
    const copy = new OwnerCopy(folder, join(folder, basename(path)));
    try {
      await copy.#fill(path);
      return copy;
    } catch (error) {
      copy[Symbol.dispose]();
      throw error;
    }
  }

  async #fill(path: string): Promise<void> {
    const files = [path, `${path}-journal`];
    const stamps = () =>
      FileStamps.read(files).catch((cause: unknown) => {
        if (unreadable(cause)) throw new UnavailableError(path, cause);
        throw cause;
      });
    for (let attempt = 0; attempt < attempts; attempt++) {
      const before = await stamps();
      await this.#copy(path);
      if ((await stamps()).equals(before)) {
        rollBack(this.file);
        return;
      }
    }
    throw new DatabaseChangingError(path, attempts);
  }

  async #copy(path: string): Promise<void> {
    const journal = `${this.file}-journal`;
    await rm(this.file, { force: true });
    await rm(journal, { force: true });
    try {
      await clone(path, this.file);
    } catch (cause) {
      if (unreadable(cause)) throw new UnavailableError(path, cause);
      throw cause;
    }
    try {
      await clone(`${path}-journal`, journal);
    } catch (cause) {
      if (!isErrno(cause, 'ENOENT')) throw cause;
    }
  }

  [Symbol.dispose](): void {
    rmSync(this.#folder, { recursive: true, force: true });
  }
}

// A first read through a connection that may write rolls back a hot journal,
// so the copy holds the last commit and no part of an open transaction.
function rollBack(file: string): void {
  using database = new DatabaseSync(file);
  database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
}
