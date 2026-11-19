import type { DatabaseSync } from 'node:sqlite';

import { fromHex, toHex } from './float64.ts';
import type { EmbeddingCacheStore } from './index.ts';
import { tableName } from './table-name.ts';

/**
 * Keeps each vector in a SQLite table, `key TEXT PRIMARY KEY, vector BLOB`,
 * as the bytes of its float64 values. Creates the table when it is missing;
 * an existing table keeps its other columns and rows.
 */
export class SqliteEmbeddingCacheStore implements EmbeddingCacheStore {
  readonly #database: DatabaseSync;
  readonly #table: string;

  constructor({ database, table }: { database: DatabaseSync; table: string }) {
    this.#database = database;
    this.#table = tableName(table);
  }

  async get(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    this.#create();
    const rows = this.#database
      .prepare(
        `SELECT key, hex(vector) AS vector FROM ${this.#table} WHERE key IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(keys));
    return new Map(
      rows.map((row) => [String(row['key']), fromHex(String(row['vector']))]),
    );
  }

  async set(entries: ReadonlyMap<string, readonly number[]>): Promise<void> {
    this.#create();
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
      );
  }

  #create(): void {
    this.#database.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#table} (key TEXT PRIMARY KEY, vector BLOB NOT NULL)`,
    );
  }
}
