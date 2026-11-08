import type { DatabaseSync } from 'node:sqlite';

import type { SnapshotState } from '@zukhruf/snapshot-differential';
import { open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import { SequencedBatch } from './batch.ts';
import type { ChangeEvent } from './change-event.ts';
import type { Position, PositionUpdate, TablePosition } from './position.ts';
import type { WalProgress } from './wal-frames.ts';

/**
 * A position in a SQLite file of the feed, at the path that the host gives:
 * the key columns of each table and one fingerprint for each (table, key). A
 * new run of a feed goes on from it. A missing or empty file is a position
 * that no pass saved.
 */
export class PositionFile implements Position<SequencedBatch> {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = open(path);
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS tables (
          name TEXT PRIMARY KEY,
          key_columns TEXT NOT NULL,
          columns TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS fingerprints (
          table_name TEXT NOT NULL,
          key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          PRIMARY KEY (table_name, key)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS wal (
          salt TEXT NOT NULL,
          frames INTEGER NOT NULL
        ) STRICT;
      `);
    } catch (cause) {
      this.#database.close();
      throw cause;
    }
  }

  // The next save keeps this batch, so the batch has its number.
  batch(events: readonly ChangeEvent[]): SequencedBatch {
    return new SequencedBatch(events, this.#saves() + 1);
  }

  started(): boolean {
    return this.#saves() > 0;
  }

  wal(): WalProgress | null {
    const row = this.#database.prepare('SELECT salt, frames FROM wal').get();
    if (row === undefined) return null;
    if (typeof row.salt !== 'string' || typeof row.frames !== 'number')
      throw new TypeError(
        'The position file holds no WAL progress of its form',
      );
    return { salt: row.salt, frames: row.frames };
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

  table(table: string): TablePosition {
    const row = this.#database
      .prepare('SELECT key_columns, columns FROM tables WHERE name = ?')
      .get(table);
    if (row === undefined)
      throw new RangeError(`The position has no table ${table}`);
    return {
      keyColumns: columnsOf(String(row.key_columns)),
      columns: columnsOf(String(row.columns)),
      state: this.#state(table),
    };
  }

  #state(table: string): SnapshotState {
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
  save({ tables, dropped, wal }: PositionUpdate): void {
    const forgetTable = this.#database.prepare(
      'DELETE FROM tables WHERE name = ?',
    );
    const forgetRows = this.#database.prepare(
      'DELETE FROM fingerprints WHERE table_name = ?',
    );
    const keepTable = this.#database.prepare(
      'INSERT INTO tables (name, key_columns, columns) VALUES (?, ?, ?)',
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
        for (const [table, { keyColumns, columns, state }] of tables) {
          keepTable.run(
            table,
            JSON.stringify(keyColumns),
            JSON.stringify(columns),
          );
          for (const [key, entry] of Object.entries(state.snapshot))
            keepRow.run(table, key, fingerprintOf(entry));
        }
        this.#database.exec('DELETE FROM wal');
        if (wal !== null)
          this.#database
            .prepare('INSERT INTO wal (salt, frames) VALUES (?, ?)')
            .run(wal.salt, wal.frames);
        this.#database.exec(`PRAGMA user_version = ${this.#saves() + 1}`);
      },
      { mode: 'immediate' },
    );
  }

  // The user version of the file counts the saves.
  #saves(): number {
    const saves = this.#database
      .prepare('PRAGMA user_version')
      .get()?.user_version;
    if (typeof saves !== 'number')
      throw new TypeError(`The position file gave ${String(saves)} saves`);
    return saves;
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
