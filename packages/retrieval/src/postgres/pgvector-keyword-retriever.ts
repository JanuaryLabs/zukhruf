import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordsOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { identifier } from '../sql/identifier.ts';
import { where } from '../sql/where.ts';
import { bind } from './bind.ts';
import { dialect } from './dialect.ts';
import { passage, passageJson } from './passage-row.ts';
import {
  type PostgresPassageStore,
  contractOf,
} from './postgres-passage-store.ts';
import type { PostgresSession } from './postgres-session.ts';

/**
 * Ranks the passages by Postgres full-text search over the keyword index
 * that elt writes: a `tsvector` column of the passages, `to_tsvector(configuration,
 * text)`, with a GIN index (ADR 0004). The score is `ts_rank_cd`, which is
 * higher for a better match (ADR 0005). It matches the words of `keywords`,
 * or of `query` when the bundle has none (ADR 0013).
 * It gives the passages with the metadata that its store reads (ADR 0015).
 */
export class PgvectorKeywordRetriever<
  // `in out M`: TypeScript cannot measure M through the filter's mapped keys,
  // and a class method checks its parameters both ways (ADR 0015).
  in out M extends Metadata = Metadata,
> implements Retriever<QueryType, StoredPassage<M>> {
  readonly #session: PostgresSession;
  readonly #passages: string;
  readonly #metadata: (columns: Metadata) => M;
  readonly #index: string;
  readonly #operator: 'AND' | 'OR';
  readonly #configuration: string;

  constructor(options: {
    /** The store of the passages, whose session and schema the search uses. */
    readonly store: PostgresPassageStore<M>;
    /** The keyword index as elt writes it. */
    readonly index: {
      /** The `tsvector` column of the passages. */
      readonly column: string;
      /** The text search configuration that made the column, 'english' when absent. */
      readonly configuration?: string;
    };
    /** How the words of the query join: 'AND', as `plainto_tsquery` joins them, when absent. */
    readonly operator?: 'AND' | 'OR';
  }) {
    const contract = contractOf(options.store);
    this.#session = contract.session;
    this.#passages = contract.passages;
    this.#metadata = contract.metadata;
    this.#index = identifier(options.index.column);
    this.#operator = options.operator ?? 'AND';
    this.#configuration = options.index.configuration ?? 'english';
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<StoredPassage<M>> = {},
  ): Promise<RetrievalResult<StoredPassage<M>>> {
    options.abortSignal?.throwIfAborted();
    const words = keywordsOf(query);
    if (words.length === 0) return { passages: [], failures: new Map() };
    const parameters: unknown[] = [];
    // The configuration is a parameter too, so its text is never SQL.
    const configuration = `${bind(parameters, this.#configuration)}::regconfig`;
    // Each word is its own plainto_tsquery, which reads it as plain text:
    // `&`, `|`, `!`, `<->`, `:*` and quotes stay text, never operators.
    const tsquery = words
      .map(
        (word) =>
          `plainto_tsquery(${configuration}, ${bind(parameters, word)})`,
      )
      .join(this.#operator === 'AND' ? ' && ' : ' || ');
    const row = passageJson(parameters, this.#passages);
    const filter = where(dialect, options.filter, parameters);
    const topK = bind(parameters, options.topK ?? 10);
    const rows = await this.#session.query(
      `
      SELECT ts_rank_cd(p.${this.#index}, q."query") AS "score", ${row} AS "passage"
      FROM ${this.#passages} p CROSS JOIN (SELECT ${tsquery} AS "query") q
      WHERE p.${this.#index} @@ q."query" AND ${filter}
      ORDER BY 1 DESC, p."id"::text COLLATE "C"
      LIMIT ${topK}`,
      parameters,
    );
    return {
      passages: rows.map((cells) => ({
        passage: passage(cells['passage'], this.#metadata),
        score: Number(cells['score']),
      })),
      failures: new Map(),
    };
  }
}
