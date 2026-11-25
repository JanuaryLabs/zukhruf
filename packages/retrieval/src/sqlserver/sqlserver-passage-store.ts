import type { PassageStore } from '../passage-store.ts';
import type { Metadata, StoredPassage } from '../passage.ts';
import { binary } from './binary.ts';
import { bind } from './bind.ts';
import { identifier } from './identifier.ts';
import { passage, passageJson } from './passage-row.ts';
import type { SqlServerSession } from './sqlserver-session.ts';

/** The connection and the relations of a SqlServerPassageStore, which the SQL Server retrievers read through it. */
export type SqlServerContract<M extends Metadata> = {
  readonly session: SqlServerSession;
  /** The passages, qualified by the schema of the store when it has one. */
  readonly passages: string;
  /** Another relation of the contract, such as the passage vectors or the table of the full-text index, qualified as the passages are. */
  relation(name: string): string;
  /** Reads the metadata of a passage from the other columns of its row. */
  readonly metadata: (columns: Metadata) => M;
};

const bridge: {
  contractOf: <M extends Metadata>(
    store: SqlServerPassageStore<M>,
  ) => SqlServerContract<M>;
} = {
  contractOf: () => {
    throw new Error(
      'retrieval: the SqlServerPassageStore class has not loaded',
    );
  },
};

/** The connection and the relations of a store, so a retriever states neither again. Not exported from the package. */
export function contractOf<M extends Metadata>(
  store: SqlServerPassageStore<M>,
): SqlServerContract<M> {
  return bridge.contractOf(store);
}

/**
 * The passage contract in SQL Server: the connection, the schema and the
 * passages, which the SQL Server retrievers and ContextWindow compose with.
 * The schema qualifies every relation of the contract: the passages, the
 * passage vectors and the table of the full-text index. It reads passages by
 * id, and the neighbours of a passage in its source. Ids and sources compare
 * in binary (`Latin1_General_100_BIN2`), so `A` is not `a` under a
 * case-insensitive database.
 */
export class SqlServerPassageStore<
  M extends Metadata = Metadata,
> implements PassageStore<M> {
  readonly #session: SqlServerSession;
  readonly #schema: string | undefined;
  readonly #passages: string;
  readonly #metadata: (columns: Metadata) => M;

  static {
    bridge.contractOf = (store) => ({
      session: store.#session,
      passages: store.#passages,
      relation: (name) => store.#relation(name),
      metadata: store.#metadata,
    });
  }

  constructor(options: {
    readonly session: SqlServerSession;
    /** The schema of the contract; the default schema of the user finds each relation when absent. */
    readonly schema?: string;
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
    this.#session = options.session;
    this.#schema = options.schema;
    this.#passages = this.#relation(options.passages);
    this.#metadata = options.metadata;
  }

  #relation(name: string): string {
    return this.#schema === undefined
      ? identifier(name)
      : `${identifier(this.#schema)}.${identifier(name)}`;
  }

  async get(
    ids: readonly string[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ReadonlyMap<string, StoredPassage<M>>> {
    const parameters: Record<string, unknown> = {};
    const list = bind(parameters, JSON.stringify(ids));
    const rows = await this.#session.query(
      `SELECT ${passageJson} AS [passage] FROM ${this.#passages} p WHERE p.[id] ${binary} IN (SELECT j.[value] FROM OPENJSON(${list}) j)`,
      parameters,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return new Map(
      rows.map((cells) => {
        const found = passage(cells['passage'], this.#metadata);
        return [found.id, found];
      }),
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
    const parameters: Record<string, unknown> = {};
    const source = bind(parameters, options.source);
    const from = bind(parameters, options.seq - options.windowSize);
    const to = bind(parameters, options.seq + options.windowSize);
    const rows = await this.#session.query(
      `SELECT ${passageJson} AS [passage] FROM ${this.#passages} p WHERE p.[source] = ${source} ${binary} AND p.[seq] BETWEEN ${from} AND ${to} ORDER BY p.[seq], p.[id] ${binary}`,
      parameters,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return rows.map((cells) => passage(cells['passage'], this.#metadata));
  }
}
