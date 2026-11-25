import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { StoredPassage } from '../passage.ts';
import { type QueryType, keywordsOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { identifier } from '../sql/identifier.ts';
import { where } from '../sql/where.ts';
import { dialect } from './dialect.ts';
import { passageRows } from './passage-rows.ts';
import { type SqlitePassageStore, contractOf } from './sqlite-passage-store.ts';

/**
 * Ranks the passages by FTS5 `bm25()` over the keyword index that elt writes:
 * an FTS5 table with the passages as its external content (ADR 0004). The
 * score is `-bm25()`, so a better match has a higher score (ADR 0005). It
 * matches the words of `keywords`, or of `query` when the bundle has none
 * (ADR 0013).
 */
export class SqliteBM25Retriever implements Retriever<
  QueryType,
  StoredPassage
> {
  readonly #database: DatabaseSync;
  readonly #passages: string;
  readonly #index: string;
  readonly #operator: 'AND' | 'OR';

  constructor(options: {
    /** The store of the passages, whose connection the search runs on. */
    readonly store: SqlitePassageStore;
    /** The FTS5 table over the passages, in the database of the store. */
    readonly index: string;
    /** How the words of the query join: 'AND', the implicit operator of FTS5, when absent. */
    readonly operator?: 'AND' | 'OR';
  }) {
    const { database, passages } = contractOf(options.store);
    this.#database = database;
    this.#passages = passages;
    this.#index = identifier(options.index);
    this.#operator = options.operator ?? 'AND';
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<StoredPassage> = {},
  ): Promise<RetrievalResult<StoredPassage>> {
    options.abortSignal?.throwIfAborted();
    const words = keywordsOf(query);
    if (words.length === 0) return { passages: [], failures: new Map() };
    const parameters: SQLInputValue[] = [ftsQuery(words, this.#operator)];
    const filter = where(dialect, options.filter, parameters);
    parameters.push(options.topK ?? 10);
    const statement = this.#database.prepare(`
      SELECT -bm25(${this.#index}) AS "score", p.*
      FROM ${this.#index} JOIN ${this.#passages} p ON p.rowid = ${this.#index}.rowid
      WHERE ${this.#index} MATCH ? AND ${filter}
      ORDER BY bm25(${this.#index}), p."id"
      LIMIT ?`);
    return {
      passages: passageRows(statement, 1, parameters).map(
        ({ cells: [score], passage }) => ({
          passage,
          score: Number(score),
        }),
      ),
      failures: new Map(),
    };
  }
}

/**
 * Each word as an FTS5 phrase, with a `"` in it doubled, so no word of the
 * query is FTS5 syntax: `-`, `:`, `*`, `NEAR` and `OR` stay words
 * (sqlite.org/fts5.html §3), as text2sql's `toFtsQuery` quotes them (#5410).
 */
const ftsQuery = (words: readonly string[], operator: 'AND' | 'OR'): string =>
  words.map((word) => `"${word.replaceAll('"', '""')}"`).join(` ${operator} `);
