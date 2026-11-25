import type { DatabaseSync } from 'node:sqlite';

import type { PassageStore } from '../passage-store.ts';
import type { StoredPassage } from '../passage.ts';
import { identifier } from '../sql/identifier.ts';
import { passageRows } from './passage-rows.ts';

/** The connection and the passages of a SqlitePassageStore, which the SQLite retrievers read through it. */
export type SqliteContract = {
  readonly database: DatabaseSync;
  /** The passages as one SQLite identifier. */
  readonly passages: string;
};

const bridge: { contractOf: (store: SqlitePassageStore) => SqliteContract } = {
  contractOf: () => {
    throw new Error('retrieval: the SqlitePassageStore class has not loaded');
  },
};

/** The connection and the passages of a store, so a retriever states neither again. Not exported from the package. */
export function contractOf(store: SqlitePassageStore): SqliteContract {
  return bridge.contractOf(store);
}

/**
 * The passage contract in SQLite: the connection and the passages, which the
 * SQLite retrievers and ContextWindow compose with. It reads passages by id,
 * and the neighbours of a passage in its source.
 */
export class SqlitePassageStore implements PassageStore {
  readonly #database: DatabaseSync;
  readonly #passages: string;

  static {
    bridge.contractOf = (store) => ({
      database: store.#database,
      passages: store.#passages,
    });
  }

  constructor(options: {
    readonly database: DatabaseSync;
    readonly passages: string;
  }) {
    this.#database = options.database;
    this.#passages = identifier(options.passages);
  }

  async get(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, StoredPassage>> {
    const statement = this.#database.prepare(
      `SELECT p.* FROM ${this.#passages} p WHERE p."id" IN (SELECT "value" FROM json_each(?))`,
    );
    return new Map(
      passageRows(statement, 0, [JSON.stringify(ids)]).map(({ passage }) => [
        passage.id,
        passage,
      ]),
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
  }): Promise<StoredPassage[]> {
    const statement = this.#database.prepare(
      `SELECT p.* FROM ${this.#passages} p WHERE p."source" = ? AND p."seq" BETWEEN ? AND ? ORDER BY p."seq", p."id"`,
    );
    return passageRows(statement, 0, [
      options.source,
      options.seq - options.windowSize,
      options.seq + options.windowSize,
    ]).map(({ passage }) => passage);
  }
}
