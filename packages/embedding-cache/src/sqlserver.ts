import { fromHex, toHex } from './float64.ts';
import type { EmbeddingCacheStore } from './index.ts';
import { tableNameParts } from './table-name.ts';

/**
 * One connection to SQL Server: only the method that the store calls, so the
 * package imports no driver. A host writes it over its own driver.
 */
export interface SqlServerSession {
  /**
   * Runs one batch with named parameters. Resolves to the rows of the batch.
   * Rejects with the error of the driver as it is: the store reads its
   * `number` (208 for a missing table, 2714 for a table that exists).
   */
  query(
    sql: string,
    parameters: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}

/** SQL Server's error numbers that the store answers; any other error reaches the caller. */
const invalidObjectName = 208;
const objectExists = 2714;

/**
 * Keeps each vector in a SQL Server table, `[key] VARCHAR(64) PRIMARY KEY,
 * vector VARBINARY(MAX)`, as the bytes of its float64 values. Not the
 * `VECTOR` type, which keeps float32 or float16 and would round. A read or
 * write that finds no table creates it and runs again. Each parameter and
 * each column it reads is a string, so no driver has to map a binary type.
 */
export class SqlServerEmbeddingCacheStore implements EmbeddingCacheStore {
  readonly #session: SqlServerSession;
  readonly #table: string;

  constructor({
    session,
    table,
  }: {
    session: SqlServerSession;
    table: string;
  }) {
    this.#session = session;
    this.#table = tableNameParts(table)
      .map((part) => `[${part}]`)
      .join('.');
  }

  async get(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    const rows = await this.#creatingTable(() =>
      this.#session.query(
        `SELECT [key], CONVERT(VARCHAR(MAX), vector, 2) AS vector FROM ${this.#table}
         WHERE [key] IN (SELECT [key] FROM OPENJSON(@keys) WITH ([key] VARCHAR(MAX) '$'))`,
        { keys: JSON.stringify(keys) },
      ),
    );
    return new Map(
      rows.map((row) => [String(row['key']), fromHex(String(row['vector']))]),
    );
  }

  async set(entries: ReadonlyMap<string, readonly number[]>): Promise<void> {
    await this.#creatingTable(() =>
      this.#session.query(
        `MERGE ${this.#table} WITH (HOLDLOCK) AS target
         USING (
           SELECT [key], CONVERT(VARBINARY(MAX), vector, 2) AS vector
           FROM OPENJSON(@entries) WITH ([key] VARCHAR(MAX) '$[0]', vector VARCHAR(MAX) '$[1]')
         ) AS source
         ON target.[key] = source.[key]
         WHEN NOT MATCHED THEN INSERT ([key], vector) VALUES (source.[key], source.vector);`,
        {
          entries: JSON.stringify(
            [...entries].map(([key, vector]) => [key, toHex(vector)]),
          ),
        },
      ),
    );
  }

  /**
   * Runs the batch; when it finds no table, creates the table and runs it
   * once more. A create that finds the table made by a concurrent store
   * counts as done.
   */
  async #creatingTable<T>(batch: () => Promise<T>): Promise<T> {
    try {
      return await batch();
    } catch (error) {
      if (errorNumber(error) !== invalidObjectName) throw error;
      try {
        await this.#session.query(
          `CREATE TABLE ${this.#table} ([key] VARCHAR(64) NOT NULL PRIMARY KEY, vector VARBINARY(MAX) NOT NULL)`,
          {},
        );
      } catch (createError) {
        if (errorNumber(createError) !== objectExists) throw createError;
      }
      return await batch();
    }
  }
}

function errorNumber(error: unknown): unknown {
  return Error.isError(error) && 'number' in error ? error.number : undefined;
}
