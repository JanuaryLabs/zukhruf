import type { DatabaseSync } from 'node:sqlite';

/**
 * How SQLite keeps a commit safe. `open` gives the connection of an owner to
 * its journal, which sets it up (ADR 0004). A new journal is a class that
 * implements this interface.
 */
export interface Journal {
  apply(database: DatabaseSync): void;
}
