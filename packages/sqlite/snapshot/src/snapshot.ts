import type {
  DatabaseSync,
  PrepareOptions,
  SQLInputValue,
  SQLOutputValue,
  StatementSync,
} from 'node:sqlite';

import { open } from '@zukhruf/sqlite-open';

import { MissingColumnsError } from './missing-columns-error.ts';
import { OwnerCopy } from './owner-copy.ts';

// The columns a reader depends on, by table.
export type SnapshotColumns = Readonly<Record<string, readonly string[]>>;

// A SQLite database another process owns and writes while it runs, read
// read-only and pinned to one moment by a read transaction, so its tables
// agree. Never opened immutable: the owner keeps a persistent WAL, where the
// newest rows live. Hold it only while reading: an open read stops the owner
// checkpointing its WAL.
export class Snapshot implements Disposable {
  readonly path: string;
  readonly #database: DatabaseSync;
  readonly #copy: Disposable;

  // copy is the private copy that ofExclusiveOwner reads in place of path.
  constructor(path: string, copy?: OwnerCopy) {
    this.path = path;
    this.#copy = copy ?? { [Symbol.dispose]() {} };
    this.#database = open(copy?.file ?? path, { readOnly: true });
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

  // A database whose owner holds SQLite's exclusive locking mode, as Chromium
  // holds its History: the owner lets no reader in, so the snapshot reads a
  // private copy at the owner's last commit. Dispose it as soon as the read
  // ends: the copy is a file until then.
  static async ofExclusiveOwner(path: string): Promise<Snapshot> {
    return new Snapshot(path, await OwnerCopy.take(path));
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

  // A statement with its own options, such as readBigInts for an integer
  // beyond 2^53, which a plain read throws on. It reads the same moment.
  prepare(sql: string, options?: PrepareOptions): StatementSync {
    return this.#database.prepare(sql, options);
  }

  [Symbol.dispose](): void {
    if (this.#database.isOpen) {
      if (this.#database.isTransaction) this.#database.exec('COMMIT');
      this.#database.close();
    }
    this.#copy[Symbol.dispose]();
  }
}
