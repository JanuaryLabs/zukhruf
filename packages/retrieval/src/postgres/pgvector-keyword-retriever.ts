import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import type { ScoredPassage } from '../scored-passage.ts';
import { bind } from './bind.ts';
import { identifier } from './identifier.ts';
import { passage, passageJson } from './passage-row.ts';
import type { PostgresSession } from './postgres-session.ts';
import { where } from './where.ts';

/**
 * Ranks the passages by Postgres full-text search over the keyword index
 * that elt writes: a `tsvector` column of the passages, `to_tsvector(configuration,
 * text)`, with a GIN index (ADR 0004). The score is `ts_rank_cd`, which is
 * higher for a better match (ADR 0005).
 */
export class PgvectorKeywordRetriever implements Retriever {
  readonly #session: PostgresSession;
  readonly #passages: string;
  readonly #index: string;
  readonly #operator: 'AND' | 'OR';
  readonly #configuration: string;

  constructor(options: {
    readonly session: PostgresSession;
    readonly passages: string;
    /** The `tsvector` column of the passages. */
    readonly index: string;
    /** How the words of the query join: 'AND', as `plainto_tsquery` joins them, when absent. */
    readonly operator?: 'AND' | 'OR';
    /** The text search configuration of the index, 'english' when absent. */
    readonly configuration?: string;
  }) {
    this.#session = options.session;
    this.#passages = identifier(options.passages);
    this.#index = identifier(options.index);
    this.#operator = options.operator ?? 'AND';
    this.#configuration = options.configuration ?? 'english';
  }

  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    options.abortSignal?.throwIfAborted();
    const words = query.split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) return [];
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
    const filter = where(options.filter, parameters);
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
    return rows.map((cells) => ({
      passage: passage(cells['passage']),
      score: Number(cells['score']),
    }));
  }
}
