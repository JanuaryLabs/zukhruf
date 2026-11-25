import type { DatabaseSync } from 'node:sqlite';

import type { PassageStore } from '../passage-store.ts';
import type { Metadata, StoredPassage } from '../passage.ts';
import { identifier } from '../sql/identifier.ts';
import { passageRows } from './passage-rows.ts';

/** The connection and the passages of a SqlitePassageStore, which the SQLite retrievers read through it. */
export type SqliteContract<M extends Metadata> = {
  readonly database: DatabaseSync;
  /** The passages as one SQLite identifier. */
  readonly passages: string;
  /** Reads the metadata of a passage from the other columns of its row. */
  readonly metadata: (columns: Metadata) => M;
};

const bridge: {
  contractOf: <M extends Metadata>(
    store: SqlitePassageStore<M>,
  ) => SqliteContract<M>;
} = {
  contractOf: () => {
    throw new Error('retrieval: the SqlitePassageStore class has not loaded');
  },
};

/** The connection and the passages of a store, so a retriever states neither again. Not exported from the package. */
export function contractOf<M extends Metadata>(
  store: SqlitePassageStore<M>,
): SqliteContract<M> {
  return bridge.contractOf(store);
}

/**
 * The passage contract in SQLite: the connection and the passages, which the
 * SQLite retrievers and ContextWindow compose with. It reads passages by id,
 * and the neighbours of a passage in its source. Its `metadata` reads the
 * host's metadata `M` from each row, so the store and every retriever over
 * it give `StoredPassage<M>` (ADR 0015).
 */
export class SqlitePassageStore<
  M extends Metadata = Metadata,
> implements PassageStore<M> {
  readonly #database: DatabaseSync;
  readonly #passages: string;
  readonly #metadata: (columns: Metadata) => M;

  static {
    bridge.contractOf = (store) => ({
      database: store.#database,
      passages: store.#passages,
      metadata: store.#metadata,
    });
  }

  constructor(options: {
    readonly database: DatabaseSync;
    readonly passages: string;
    /**
     * Reads the metadata of a passage from the columns of its row that are
     * not the passage's own, as a zod schema's `parse` does; what it throws,
     * the read rejects with. `(columns) => columns` keeps every column.
     * `M` types the filter, and the filter runs as SQL on the columns, so
     * the reader may check, narrow or drop columns, never rename them or
     * convert their values: a filter on a renamed key, or on a value of a
     * converted type such as a `Date`, compiles and fails at run time.
     */
    readonly metadata: (columns: Metadata) => M;
  }) {
    this.#database = options.database;
    this.#passages = identifier(options.passages);
    this.#metadata = options.metadata;
  }

  async get(
    ids: readonly string[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ReadonlyMap<string, StoredPassage<M>>> {
    // node:sqlite runs the statement synchronously: no abort can land while
    // it runs, so the signal is checked before it (ADR 0017).
    options.signal?.throwIfAborted();
    const statement = this.#database.prepare(
      `SELECT p.* FROM ${this.#passages} p WHERE p."id" IN (SELECT "value" FROM json_each(?))`,
    );
    return new Map(
      passageRows(statement, 0, [JSON.stringify(ids)], this.#metadata).map(
        ({ passage }) => [passage.id, passage],
      ),
    );
  }

  /**
   * The passages of the source from `seq - windowSize` to `seq + windowSize`,
   * the passage itself among them, in the order of `seq`, as Haystack's
   * `SentenceWindowRetriever` reads its window.
   */
  async neighbours(options: {
    readonly source: string;
    readonly seq: number;
    readonly windowSize: number;
    readonly signal?: AbortSignal;
  }): Promise<StoredPassage<M>[]> {
    options.signal?.throwIfAborted();
    const statement = this.#database.prepare(
      `SELECT p.* FROM ${this.#passages} p WHERE p."source" = ? AND p."seq" BETWEEN ? AND ? ORDER BY p."seq", p."id"`,
    );
    return passageRows(
      statement,
      0,
      [
        options.source,
        options.seq - options.windowSize,
        options.seq + options.windowSize,
      ],
      this.#metadata,
    ).map(({ passage }) => passage);
  }
}
