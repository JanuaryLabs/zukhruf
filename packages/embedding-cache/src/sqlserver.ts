import { fromHex, toHex } from './float64.ts';
import type { EmbeddingCacheStore } from './index.ts';
import { tableName } from './table-name.ts';

/**
 * One connection to SQL Server: only the method that the store calls, so the
 * package imports no driver. A host writes it over its own driver.
 */
export interface SqlServerSession {
  /** Runs one batch with named parameters. Resolves to the rows of the batch. */
  query(
    sql: string,
    parameters: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}

/**
 * Keeps each vector in a SQL Server table, `[key] CHAR(64) PRIMARY KEY,
 * vector VARBINARY(MAX)`, as the bytes of its float64 values. Not the
 * `VECTOR` type, which keeps float32 or float16 and would round. Each batch
 * creates the table when it is missing. Each parameter and each column it
 * reads is a string, so no driver has to map a binary type.
 */
export class SqlServerEmbeddingCacheStore implements EmbeddingCacheStore {
  readonly #session: SqlServerSession;
  readonly #table: string;
  readonly #createTable: string;

  constructor({
    session,
    table,
  }: {
    session: SqlServerSession;
    table: string;
  }) {
    this.#session = session;
    this.#table = tableName(table);
    this.#createTable = `IF OBJECT_ID(@table) IS NULL
      CREATE TABLE ${this.#table} ([key] CHAR(64) NOT NULL PRIMARY KEY, vector VARBINARY(MAX) NOT NULL);`;
  }

  async get(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    const rows = await this.#session.query(
      `${this.#createTable}
       SELECT [key], CONVERT(VARCHAR(MAX), vector, 2) AS vector FROM ${this.#table}
       WHERE [key] IN (SELECT [key] FROM OPENJSON(@keys) WITH ([key] CHAR(64) '$'))`,
      { table: this.#table, keys: JSON.stringify(keys) },
    );
    return new Map(
      rows.map((row) => [String(row['key']), fromHex(String(row['vector']))]),
    );
  }

  async set(entries: ReadonlyMap<string, readonly number[]>): Promise<void> {
    await this.#session.query(
      `${this.#createTable}
       MERGE ${this.#table} WITH (HOLDLOCK) AS target
       USING (
         SELECT [key], CONVERT(VARBINARY(MAX), vector, 2) AS vector
         FROM OPENJSON(@entries) WITH ([key] CHAR(64) '$[0]', vector VARCHAR(MAX) '$[1]')
       ) AS source
       ON target.[key] = source.[key]
       WHEN NOT MATCHED THEN INSERT ([key], vector) VALUES (source.[key], source.vector);`,
      {
        table: this.#table,
        entries: JSON.stringify(
          [...entries].map(([key, vector]) => [key, toHex(vector)]),
        ),
      },
    );
  }
}
