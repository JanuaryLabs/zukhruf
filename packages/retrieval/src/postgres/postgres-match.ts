import type { Metadata, StoredPassage } from '../passage.ts';
import type { KeywordQuery } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import { where } from '../sql/where.ts';
import { bind } from './bind.ts';
import { dialect } from './dialect.ts';
import { passage, passageJson } from './passage-row.ts';
import type { PostgresSession } from './postgres-session.ts';

/** The `tsvector` column that a match searches, and the passages it indexes. */
export interface TsvectorIndex<M extends Metadata> {
  readonly session: PostgresSession;
  readonly passages: string;
  readonly metadata: (columns: Metadata) => M;
  readonly column: string;
  readonly configuration: string;
}

/**
 * Strategy (GoF): one way to match a keyword query in Postgres full-text
 * search and rank the passages it finds; `PgvectorKeywordRetriever` picks one
 * in its constructor.
 */
export interface PostgresMatch<M extends Metadata> {
  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<RetrievalResult<StoredPassage<M>>>;
}

/** A passage matches when it holds every word, as `plainto_tsquery` joins them. */
export class AllWords<M extends Metadata> implements PostgresMatch<M> {
  readonly #index: TsvectorIndex<M>;

  constructor(index: TsvectorIndex<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<RetrievalResult<StoredPassage<M>>> {
    return tsRankCd(this.#index, query, options);
  }
}

/** The passages that hold every word, best `ts_rank_cd` first. */
async function tsRankCd<M extends Metadata>(
  { session, passages, metadata, column, configuration }: TsvectorIndex<M>,
  query: KeywordQuery,
  options: RetrieveOptions<StoredPassage<M>>,
): Promise<RetrievalResult<StoredPassage<M>>> {
  const words = wordsOf(query);
  if (words.length === 0) return { passages: [], failures: new Map() };
  const parameters: unknown[] = [];
  // The configuration is a parameter too, so its text is never SQL.
  const regconfig = `${bind(parameters, configuration)}::regconfig`;
  // Each word is its own plainto_tsquery, which reads it as plain text:
  // `&`, `|`, `!`, `<->`, `:*` and quotes stay text, never operators.
  const tsquery = words
    .map((word) => `plainto_tsquery(${regconfig}, ${bind(parameters, word)})`)
    .join(' && ');
  const row = passageJson(parameters, passages);
  const filter = where(dialect, options.filter, parameters);
  const topK = bind(parameters, options.topK ?? 10);
  const rows = await session.query(
    `
      SELECT ts_rank_cd(p.${column}, q."query") AS "score", ${row} AS "passage"
      FROM ${passages} p CROSS JOIN (SELECT ${tsquery} AS "query") q
      WHERE p.${column} @@ q."query" AND ${filter}
      ORDER BY 1 DESC, p."id"::text COLLATE "C"
      LIMIT ${topK}`,
    parameters,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return {
    passages: rows.map((cells) => ({
      passage: passage(cells['passage'], metadata),
      score: Number(cells['score']),
    })),
    failures: new Map(),
  };
}

/**
 * The white-space words of each keyword, or of the text: today's split, the
 * same on every engine until each one tokenizes its own way (#5669).
 */
const wordsOf = (query: KeywordQuery): string[] =>
  (query.kind === 'keywords' ? query.keywords : [query.text])
    .flatMap((text) => text.split(/\s+/))
    .filter((word) => word !== '');
