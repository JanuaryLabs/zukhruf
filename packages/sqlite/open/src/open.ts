import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';

import type { Journal } from './journal.ts';
import { UnavailableError } from './unavailable-error.ts';
import { WriteAheadLog } from './write-ahead-log.ts';

type Path = ConstructorParameters<typeof DatabaseSync>[0];
type Settings = Omit<DatabaseSyncOptions, 'open' | 'readOnly'>;

/** A reader: a read-only connection that never changes the database. */
export type ReaderOptions = Settings & {
  readonly readOnly: true;
  readonly journal?: never;
};

/** The connection of the owner, which writes the database and sets its journal. */
export type OwnerOptions = Settings & {
  readonly readOnly?: false;
  readonly journal?: Journal;
};

/** Opens a connection: a reader with `readOnly: true`, else an owner (ADR 0002). */
export function open(
  path: Path,
  options: ReaderOptions | OwnerOptions = {},
): DatabaseSync {
  if (options.readOnly) return connect(path, options);
  const { journal = new WriteAheadLog(), ...settings } = options;
  // The owner opens with extension loading on, so that a journal can load the
  // native library; the step after the journal sets it as the caller asked.
  const database = connect(path, { ...settings, allowExtension: true });
  try {
    // A database in memory (':memory:', '', a file::memory: URI) has no file,
    // so it has no journal to set.
    if (database.location() !== null) journal.apply(database);
    database.enableLoadExtension(settings.allowExtension ?? false);
    return database;
  } catch (error) {
    database.close();
    throw UnavailableError.from(String(path), error) ?? error;
  }
}

// The busy timeout when the caller gives none, in milliseconds, as
// better-sqlite3, Python's sqlite3 and Rails have it (ADR 0005).
const busyTimeout = 5000;

function connect(path: Path, options: DatabaseSyncOptions): DatabaseSync {
  try {
    return new DatabaseSync(path, { timeout: busyTimeout, ...options });
  } catch (error) {
    throw UnavailableError.from(String(path), error) ?? error;
  }
}
