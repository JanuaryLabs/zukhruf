import type { DatabaseSync } from 'node:sqlite';

import type { Journal } from './journal.ts';

/**
 * The rollback journal: SQLite copies each page to the -journal file before a
 * commit changes it. Its first access rolls back a hot journal. For a copy
 * that must lose a hot journal, and for a file that its owner builds and then
 * renames or deletes, which must leave no -wal file behind (ADR 0004).
 */
export class RollbackJournal implements Journal {
  apply(database: DatabaseSync): void {
    database.exec('PRAGMA journal_mode = DELETE');
  }
}
