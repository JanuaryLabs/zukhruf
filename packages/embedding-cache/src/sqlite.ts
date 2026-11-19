import type { DatabaseSync } from 'node:sqlite';

import { fromHex, toHex } from './float64.ts';
import type { EmbeddingCacheStore } from './index.ts';
import { tableNameParts } from './table-name.ts';

/**
 * Keeps each vector in a SQLite table, `key TEXT PRIMARY KEY, vector BLOB`,
 * as the bytes of its float64 values. A read or write that finds no table
 * creates it and runs again; an existing table keeps its other columns and
 * rows.
 */
export class SqliteEmbeddingCacheStore implements EmbeddingCacheStore {
  readonly #database: DatabaseSync;
  readonly #table: string;

  constructor({ database, table }: { database: DatabaseSync; table: string }) {
    this.#database = database;
    this.#table = tableNameParts(table)
      .map((part) => `"${part}"`)
      .join('.');
  }

  async get(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    const rows = this.#creatingTable(() =>
      this.#database
        .prepare(
          `SELECT key, hex(vector) AS vector FROM ${this.#table} WHERE key IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(keys)),
    );
    return new Map(
      rows.map((row) => [String(row['key']), fromHex(String(row['vector']))]),
    );
  }

  async set(entries: ReadonlyMap<string, readonly number[]>): Promise<void> {
    this.#creatingTable(() =>
      this.#database
        .prepare(
          `INSERT INTO ${this.#table} (key, vector)
           SELECT value ->> 0, unhex(value ->> 1) FROM json_each(?) WHERE true
           ON CONFLICT (key) DO NOTHING`,
        )
        .run(
          JSON.stringify(
            [...entries].map(([key, vector]) => [key, toHex(vector)]),
          ),
        ),
    );
  }

  /** Runs the statement; when it finds no table, creates the table and runs it once more. */
  #creatingTable<T>(statement: () => T): T {
    try {
      return statement();
    } catch (error) {
      if (!(Error.isError(error) && error.message.startsWith('no such table:')))
        throw error;
      this.#database.exec(
        `CREATE TABLE IF NOT EXISTS ${this.#table} (key TEXT PRIMARY KEY, vector BLOB NOT NULL)`,
      );
      return statement();
    }
  }
}
