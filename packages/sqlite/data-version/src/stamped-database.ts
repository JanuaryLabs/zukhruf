import { statSync } from 'node:fs';

import { FileStamp, isErrno } from '@zukhruf/fs';
import { UnavailableError } from '@zukhruf/sqlite-reader';

// A database whose owner holds SQLite's exclusive locking mode, as Chromium
// holds its History. The owner lets no reader read data_version, but each
// commit writes the database file, so its file stamp changes. A write to the
// journal alone is a transaction the owner did not commit, and no change. A
// path this process cannot see keeps the last observation: the owner may be
// about to create the file again.
export class StampedDatabase implements Disposable {
  readonly #path: string;
  #observation: string;

  constructor(path: string) {
    try {
      statSync(path);
    } catch (cause) {
      if (isErrno(cause, 'ENOENT') || isErrno(cause, 'EACCES'))
        throw new UnavailableError(path, cause);
      throw cause;
    }
    this.#path = path;
    this.#observation = String(FileStamp.readSync(path));
  }

  observe(): string {
    let stamp: FileStamp;
    try {
      stamp = FileStamp.readSync(this.#path);
    } catch (error) {
      if (isErrno(error, 'EACCES')) return this.#observation;
      throw error;
    }
    if (stamp.modifiedAt !== undefined) this.#observation = String(stamp);
    return this.#observation;
  }

  // A stat holds nothing open.
  [Symbol.dispose](): void {}
}
