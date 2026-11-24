import type { PassageStore } from '../passage-store.ts';
import type { Passage } from '../passage.ts';
import { bind } from './bind.ts';
import { identifier } from './identifier.ts';
import { passage, passageJson } from './passage-row.ts';
import type { PostgresSession } from './postgres-session.ts';

/** The connection and the relations of a PostgresPassageStore, which the Postgres retrievers read through it. */
export type PostgresContract = {
  readonly session: PostgresSession;
  /** The passages, qualified by the schema of the store when it has one. */
  readonly passages: string;
  /** Another relation of the contract, such as the passage vectors, qualified as the passages are. */
  relation(name: string): string;
};

const bridge: {
  contractOf: (store: PostgresPassageStore) => PostgresContract;
} = {
  contractOf: () => {
    throw new Error('retrieval: the PostgresPassageStore class has not loaded');
  },
};

/** The connection and the relations of a store, so a retriever states neither again. Not exported from the package. */
export function contractOf(store: PostgresPassageStore): PostgresContract {
  return bridge.contractOf(store);
}

/**
 * The passage contract in Postgres: the connection, the schema and the
 * passages, which the Postgres retrievers and ContextWindow compose with, as
 * Haystack's retrievers take its `PgvectorDocumentStore`. The schema
 * qualifies every relation of the contract: the passages, the passage vectors
 * and the keyword index. It reads passages by id, and the neighbours of a
 * passage in its source.
 */
export class PostgresPassageStore implements PassageStore {
  readonly #session: PostgresSession;
  readonly #schema: string | undefined;
  readonly #passages: string;

  static {
    bridge.contractOf = (store) => ({
      session: store.#session,
      passages: store.#passages,
      relation: (name) => store.#relation(name),
    });
  }

  constructor(options: {
    readonly session: PostgresSession;
    /** The schema of the contract; the search_path of the session finds each relation when absent. */
    readonly schema?: string;
    readonly passages: string;
  }) {
    this.#session = options.session;
    this.#schema = options.schema;
    this.#passages = this.#relation(options.passages);
  }

  #relation(name: string): string {
    return this.#schema === undefined
      ? identifier(name)
      : `${identifier(this.#schema)}.${identifier(name)}`;
  }

  async get(ids: readonly string[]): Promise<ReadonlyMap<string, Passage>> {
    const parameters: unknown[] = [];
    const row = passageJson(parameters, this.#passages);
    const list = bind(parameters, JSON.stringify(ids));
    const rows = await this.#session.query(
      `SELECT ${row} AS "passage" FROM ${this.#passages} p WHERE p."id"::text IN (SELECT jsonb_array_elements_text(${list}::jsonb))`,
      parameters,
    );
    return new Map(
      rows.map((cells) => {
        const found = passage(cells['passage']);
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
  }): Promise<Passage[]> {
    const parameters: unknown[] = [];
    const row = passageJson(parameters, this.#passages);
    const source = bind(parameters, options.source);
    const from = bind(parameters, options.seq - options.windowSize);
    const to = bind(parameters, options.seq + options.windowSize);
    const rows = await this.#session.query(
      `SELECT ${row} AS "passage" FROM ${this.#passages} p WHERE p."source" = ${source} AND p."seq" BETWEEN ${from} AND ${to} ORDER BY p."seq", p."id"::text COLLATE "C"`,
      parameters,
    );
    return rows.map((cells) => passage(cells['passage']));
  }
}
