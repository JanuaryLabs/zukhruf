import type { DatabaseSync } from 'node:sqlite';

import type { Journal } from './journal.ts';

// Keeps the -wal file small after a large commit, as Rails 8 does: 64 MiB.
const sizeLimit = 64 * 1024 * 1024;

/** The default journal of an owner: readers and the owner do not wait for each other. */
export class WriteAheadLog implements Journal {
  apply(database: DatabaseSync): void {
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
