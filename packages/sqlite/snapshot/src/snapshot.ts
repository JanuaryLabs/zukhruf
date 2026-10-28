import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from 'node:sqlite';

import { MissingColumnsError } from './missing-columns-error.ts';
import { UnavailableError } from './unavailable-error.ts';

// The columns a reader depends on, by table.
export type SnapshotColumns = Readonly<Record<string, readonly string[]>>;

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

// A SQLite database another process owns and writes while it runs, read
// read-only and pinned to one moment by a read transaction, so its tables
// agree. Never opened immutable: the owner keeps a persistent WAL, where the
// newest rows live. Hold it only while reading: an open read stops the owner
// checkpointing its WAL.
export class Snapshot implements Disposable {
  readonly path: string;
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.#database = open(path);
    try {
      // The first read pins the snapshot, so it is taken now rather than at
      // the caller's first query; a file that is no database fails here.
      this.#database.exec('BEGIN');
      this.#database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
    } catch (cause) {
      this.#database.close();
      throw cause;
    }
  }

  // Refuses a layout without these columns, and closes the database: the
  // check a reader makes while it opens the snapshot.
  requireColumns(columns: SnapshotColumns): void {
    const missing = this.missingColumns(columns);
    if (missing.length === 0) return;
    this[Symbol.dispose]();
    throw new MissingColumnsError(this.path, missing);
  }

  // The columns, as table.column, that this layout lacks. A reader whose
  // reads use different tables checks each read with it and keeps the
  // snapshot open for the others.
  missingColumns(columns: SnapshotColumns): string[] {
    return Object.entries(columns).flatMap(([table, names]) => {
      const present = new Set(
        this.all('SELECT name FROM pragma_table_info(?)', table).map(
          (column) => column.name,
        ),
      );
      return names
        .filter((name) => !present.has(name))
        .map((name) => `${table}.${name}`);
    });
  }

  all(
    sql: string,
    ...parameters: SQLInputValue[]
  ): Record<string, SQLOutputValue>[] {
    return this.#database.prepare(sql).all(...parameters);
  }

  // Rows one at a time, for a table too large to hold whole.
  iterate(
    sql: string,
    ...parameters: SQLInputValue[]
  ): IteratorObject<Record<string, SQLOutputValue>, undefined> {
    return this.#database.prepare(sql).iterate(...parameters);
  }

  [Symbol.dispose](): void {
    if (!this.#database.isOpen) return;
    if (this.#database.isTransaction) this.#database.exec('COMMIT');
    this.#database.close();
  }
}
