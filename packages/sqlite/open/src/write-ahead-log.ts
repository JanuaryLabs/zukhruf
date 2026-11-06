import type { DatabaseSync } from 'node:sqlite';

import type { Journal } from './journal.ts';

// Keeps the -wal file small after a large commit, as Rails 8 does: 64 MiB.
const sizeLimit = 64 * 1024 * 1024;

/** A page size that SQLite accepts: a power of two from 512 to 65536. */
export type PageSize = 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768 | 65536;

/** The default journal of an owner: readers and the owner do not wait for each other. */
export class WriteAheadLog implements Journal {
  readonly #pageSize: PageSize | undefined;

  constructor(options: { readonly pageSize?: PageSize } = {}) {
    this.#pageSize = options.pageSize;
  }

  apply(database: DatabaseSync): void {
    // SQLite takes the page size of a file only before its first write, and
    // never in a write-ahead log. The WAL step writes the header of a new
    // file, so the page size comes first. An existing file keeps its own.
    if (this.#pageSize !== undefined)
      database.exec(`PRAGMA page_size = ${this.#pageSize}`);
    // The statement sets its own row shape: the caller's returnArrays and
    // readBigInts apply to the connection, and must not change this read.
    const statement = database.prepare('PRAGMA journal_mode = WAL');
    statement.setReturnArrays(false);
    const journal = statement.get()?.journal_mode;
    if (journal !== 'wal')
      throw new Error(
        `SQLite kept the journal ${JSON.stringify(journal)} of ${JSON.stringify(database.location())}, not a write-ahead log.`,
      );
    database.exec(`PRAGMA journal_size_limit = ${sizeLimit}`);
  }
}
