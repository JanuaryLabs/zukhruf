import { DatabaseSync } from 'node:sqlite';

import type { SnapshotState } from '@zukhruf/snapshot-differential';
import { transaction } from '@zukhruf/sqlite-transaction';

import type { Position, PositionUpdate } from './position.ts';

// The position of a durable feed: a SQLite file of the feed, with the key
// columns of each table and one fingerprint for each (table, key). A missing
// or empty file is a position with no tables.
export class PositionFile implements Position, Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS tables (
          name TEXT PRIMARY KEY,
          key_columns TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS fingerprints (
          table_name TEXT NOT NULL,
          key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          PRIMARY KEY (table_name, key)
        ) STRICT, WITHOUT ROWID;
      `);
    } catch (cause) {
      this.#database.close();
      throw cause;
    }
  }

  keyColumns(): ReadonlyMap<string, readonly string[]> {
    return new Map(
      this.#database
        .prepare('SELECT name, key_columns FROM tables')
        .all()
        .map(({ name, key_columns }) => [
          String(name),
          columnsOf(String(key_columns)),
        ]),
    );
  }

  state(table: string): SnapshotState {
    return {
      snapshot: Object.fromEntries(
        this.#database
          .prepare(
            'SELECT key, fingerprint FROM fingerprints WHERE table_name = ?',
          )
          .all(table)
          .map(({ key, fingerprint }) => [String(key), String(fingerprint)]),
      ),
    };
  }

  // One transaction for the position of one batch.
  save({ tables, dropped }: PositionUpdate): void {
    const forgetTable = this.#database.prepare(
      'DELETE FROM tables WHERE name = ?',
    );
    const forgetRows = this.#database.prepare(
      'DELETE FROM fingerprints WHERE table_name = ?',
    );
    const keepTable = this.#database.prepare(
      'INSERT INTO tables (name, key_columns) VALUES (?, ?)',
    );
    const keepRow = this.#database.prepare(
      'INSERT INTO fingerprints (table_name, key, fingerprint) VALUES (?, ?, ?)',
    );
    transaction(
      this.#database,
      () => {
        for (const table of [...dropped, ...tables.keys()]) {
          forgetTable.run(table);
          forgetRows.run(table);
        }
        for (const [table, { keyColumns, state }] of tables) {
          keepTable.run(table, JSON.stringify(keyColumns));
          for (const [key, entry] of Object.entries(state.snapshot))
            keepRow.run(table, key, fingerprintOf(entry));
        }
      },
      { mode: 'immediate' },
    );
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

function columnsOf(json: string): readonly string[] {
  const columns: unknown = JSON.parse(json);
  if (
    !Array.isArray(columns) ||
    !columns.every((column) => typeof column === 'string')
  )
    throw new TypeError(`The position file holds ${json} as key columns`);
  return columns;
}

// The feed gives the differential no expiresBy, so each entry is a
// fingerprint alone.
function fingerprintOf(entry: SnapshotState['snapshot'][string]): string {
  if (typeof entry !== 'string')
    throw new TypeError('The position keeps no expiry');
  return entry;
}
