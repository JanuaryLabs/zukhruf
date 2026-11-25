import type { Metadata, StoredPassage } from '../passage.ts';
import type { KeywordQuery } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { ScoredPassage } from '../scored-passage.ts';
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
  /** The column as one SQL identifier. */
  readonly column: string;
  /** The name of the column, as `pg_stats.attname` holds it. */
  readonly columnName: string;
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
  ): Promise<
    RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>
  >;
}

/** A passage matches when it holds every keyword as a phrase, or every lexeme of a text. */
export class AllWords<M extends Metadata> implements PostgresMatch<M> {
  readonly #index: TsvectorIndex<M>;

  constructor(index: TsvectorIndex<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<
    RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>
  > {
    return tsRankCd(this.#index, query, options);
  }
}

/**
 * Meilisearch's `matchingStrategy: 'frequency'` with Typesense's
 * `drop_tokens_threshold` (ADR 0018): the AND of the terms, and while fewer
 * than the threshold of passages match, the AND without the most frequent
 * term, down to the rarest term alone. A term is a lexeme of a text, as
 * `to_tsvector` makes it, or a keyword, as `phraseto_tsquery` makes it. The
 * frequencies order the drops only: `pg_stats.most_common_elems` of the
 * column, read on the table that holds it when the passages are a view, for
 * the lexemes it lists, and a count capped at its smallest
 * frequency for the others, which are rarer than every listed one. A term
 * that no passage holds is left out. The score is the number of the terms a
 * passage holds plus `ts_rank(column, OR of the terms, 1 | 32)`, which is in
 * [0, 1), so the terms held order first.
 */
export class DropMostFrequent<M extends Metadata> implements PostgresMatch<M> {
  readonly #index: TsvectorIndex<M>;
  readonly #threshold: number;

  constructor(index: TsvectorIndex<M>, threshold: number) {
    this.#index = index;
    this.#threshold = threshold;
  }

  async retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<
    RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>
  > {
    const terms = await this.#rarestFirst(query, options.signal);
    let kept = terms.length;
    while (
      kept > 1 &&
      (await this.#matched(terms.slice(0, kept), options)) < this.#threshold
    ) {
      kept -= 1;
    }
    if (kept === 0) return { passages: [], failures: new Map() };
    return this.#ranked(terms.slice(0, kept), terms, options);
  }

  /**
   * The terms of the query that some passage holds, each as a tsquery, rarest
   * first. One statement reads the terms and the frequencies that `pg_stats`
   * lists; a second counts the lexemes that it does not list.
   */
  async #rarestFirst(
    query: KeywordQuery,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    const { session, passages, columnName, configuration } = this.#index;
    const parameters: unknown[] = [];
    // The configuration is a parameter too, so its text is never SQL.
    const regconfig = `${bind(parameters, configuration)}::regconfig`;
    const terms =
      query.kind === 'keywords'
        ? `SELECT DISTINCT phraseto_tsquery(${regconfig}, k)::text AS "query", tsvector_to_array(to_tsvector(${regconfig}, k)) AS "lexemes"
           FROM unnest(${bind(parameters, query.keywords)}::text[]) AS k
           WHERE numnode(phraseto_tsquery(${regconfig}, k)) > 0`
        : `SELECT ${lexemeQuery('e."lexeme"')}::text AS "query", ARRAY[e."lexeme"] AS "lexemes"
           FROM unnest(to_tsvector(${regconfig}, ${bind(parameters, query.text)})) AS e`;
    const relation = `${bind(parameters, passages)}::regclass`;
    const name = bind(parameters, columnName);
    signal?.throwIfAborted();
    // A view has no statistics, so "indexed" follows the passages through
    // their views to the table whose column of that name they read: the
    // columns the rule of a view reads are in pg_depend.
    // information_schema.view_column_usage lists them only to an owner of the
    // table, and a host often reads as a role that owns none.
    const rows = await session.query(
      `
      WITH RECURSIVE "read" AS (
        SELECT c.oid AS "relation", c.relkind
        FROM pg_class c WHERE c.oid = ${relation}
        UNION ALL
        SELECT t.oid, t.relkind
        FROM "read" v
        JOIN pg_rewrite w ON w.ev_class = v."relation"
        JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
          AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> v."relation"
        JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
          AND a.attname = ${name} AND a.atttypid = 'tsvector'::regtype
        JOIN pg_class t ON t.oid = d.refobjid
        WHERE v.relkind = 'v'),
      "indexed" AS (
        SELECT r."relation" FROM "read" r WHERE r.relkind <> 'v'
        ORDER BY r."relation" LIMIT 1),
      "term" AS (${terms}),
      "common" AS (
        SELECT e."lexeme", e."frequency"
        FROM "indexed" i
        JOIN pg_class c ON c.oid = i."relation"
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname,
        unnest(s.most_common_elems::text::text[], s.most_common_elem_freqs) AS e("lexeme", "frequency")
        WHERE s.attname = ${name} AND e."lexeme" IS NOT NULL)
      SELECT t."query",
        (SELECT min(c."frequency") FROM "common" c WHERE c."lexeme" = ANY (t."lexemes"))::float8 AS "listed",
        ARRAY(
          SELECT ${lexemeQuery('l')}::text
          FROM unnest(t."lexemes") AS l
          WHERE NOT EXISTS (SELECT 1 FROM "common" c WHERE c."lexeme" = l)) AS "unlisted",
        (SELECT ceil((SELECT min(c."frequency") FROM "common" c) * greatest(r.reltuples, 1))
         FROM "indexed" i JOIN pg_class r ON r.oid = i."relation")::int8::text AS "cap"
      FROM "term" t`,
      parameters,
      signal === undefined ? {} : { signal },
    );
    const counts = await this.#counted(
      [...new Set(rows.flatMap((row) => textsOf(row['unlisted'])))],
      rows[0]?.['cap'] ?? null,
      signal,
    );
    return rows
      .flatMap((row) => {
        const query = String(row['query']);
        const unlisted = textsOf(row['unlisted']).map(
          (lexeme) => counts.get(lexeme) ?? 0,
        );
        if (unlisted.length === 0) {
          return [{ query, listed: true, frequency: Number(row['listed']) }];
        }
        // A phrase holds every lexeme, so one that no passage holds leaves
        // the term out, and its rarest lexeme bounds its frequency.
        const frequency = Math.min(...unlisted);
        return frequency === 0 ? [] : [{ query, listed: false, frequency }];
      })
      .toSorted(
        (a, b) =>
          Number(a.listed) - Number(b.listed) ||
          a.frequency - b.frequency ||
          codeUnitOrder(a.query, b.query),
      )
      .map(({ query }) => query);
  }

  /**
   * The passages that hold each lexeme, each count stopped at `cap`, or not
   * stopped when the column has no statistics. Each is a materialized CTE,
   * as `#matched` reads it.
   */
  async #counted(
    lexemes: readonly string[],
    cap: unknown,
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, number>> {
    if (lexemes.length === 0) return new Map();
    const { session, passages, column } = this.#index;
    const parameters: unknown[] = [];
    const limit = bind(parameters, cap);
    const holding = lexemes.map(
      (lexeme, i) =>
        `"holding${i}" AS MATERIALIZED (SELECT 1 FROM ${passages} p WHERE p.${column} @@ ${bind(parameters, lexeme)}::tsquery)`,
    );
    const counts = lexemes.map(
      (_, i) =>
        `(SELECT count(*) FROM (SELECT 1 FROM "holding${i}" LIMIT ${limit}::int8) s)::int AS "${i}"`,
    );
    signal?.throwIfAborted();
    const [row] = await session.query(
      `WITH ${holding.join(', ')} SELECT ${counts.join(', ')}`,
      parameters,
      signal === undefined ? {} : { signal },
    );
    return new Map(lexemes.map((lexeme, i) => [lexeme, Number(row?.[i])]));
  }

  /**
   * How many passages that the call's filter selects hold every term, counted
   * to the threshold. The passages are a materialized CTE, which Postgres
   * plans to read in full, so it never trades the GIN index for a sequential
   * scan that it expects to stop early: on an AND of lexemes that it judges
   * common, or that it does not track, such a scan can read the whole table.
   * The `LIMIT` above the CTE stops the read at the threshold.
   */
  async #matched(
    terms: readonly string[],
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<number> {
    const { session, passages, column } = this.#index;
    const parameters: unknown[] = [];
    const tsquery = bind(parameters, allOf(terms));
    const filter = where(dialect, options.filter, parameters);
    const threshold = bind(parameters, Math.ceil(this.#threshold));
    options.signal?.throwIfAborted();
    const [row] = await session.query(
      `
      WITH "matched" AS MATERIALIZED (
        SELECT 1 FROM ${passages} p WHERE p.${column} @@ ${tsquery}::tsquery AND ${filter})
      SELECT count(*)::int AS "matched" FROM (SELECT 1 FROM "matched" LIMIT ${threshold}::int8) s`,
      parameters,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return Number(row?.['matched']);
  }

  /** The passages that hold every kept term, by the terms they hold, then `ts_rank` against the OR of every term. */
  async #ranked(
    kept: readonly string[],
    terms: readonly string[],
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<
    RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>
  > {
    const { session, passages, metadata, column } = this.#index;
    const parameters: unknown[] = [];
    const every = bind(parameters, terms);
    const any = bind(parameters, terms.map((term) => `(${term})`).join(' | '));
    const row = passageJson(parameters, passages);
    const tsquery = bind(parameters, allOf(kept));
    const filter = where(dialect, options.filter, parameters);
    const topK = bind(parameters, options.topK ?? 10);
    options.signal?.throwIfAborted();
    const rows = await session.query(
      `
      SELECT (SELECT count(*) FROM unnest(${every}::tsquery[]) AS t WHERE p.${column} @@ t)::float8
          + ts_rank(p.${column}, ${any}::tsquery, 33)::float8 AS "score",
        ${row} AS "passage"
      FROM ${passages} p
      WHERE p.${column} @@ ${tsquery}::tsquery AND ${filter}
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
}

/**
 * The SQL of a lexeme as a tsquery of that lexeme alone: single-quoted, its
 * backslashes and quotes doubled, so no character of it is tsquery syntax.
 */
const lexemeQuery = (lexeme: string): string =>
  `(chr(39) || replace(replace(${lexeme}, chr(92), chr(92) || chr(92)), chr(39), chr(39) || chr(39)) || chr(39))::tsquery`;

const codeUnitOrder = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** The texts of a `text[]` cell, as the driver gives an array. */
const textsOf = (cell: unknown): string[] =>
  Array.isArray(cell) ? cell.map(String) : [];

/** The AND of tsqueries as Postgres writes them, each in parentheses. */
const allOf = (terms: readonly string[]): string =>
  terms.map((term) => `(${term})`).join(' & ');

/** The passages that hold every term, best `ts_rank_cd` first. */
async function tsRankCd<M extends Metadata>(
  { session, passages, metadata, column, configuration }: TsvectorIndex<M>,
  query: KeywordQuery,
  options: RetrieveOptions<StoredPassage<M>>,
): Promise<RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>> {
  if (query.kind === 'text' && query.text.trim() === '') {
    return { passages: [], failures: new Map() };
  }
  const parameters: unknown[] = [];
  // The configuration is a parameter too, so its text is never SQL.
  const regconfig = `${bind(parameters, configuration)}::regconfig`;
  // Each keyword is one phraseto_tsquery, its lexemes in order (ADR 0018);
  // a text is one plainto_tsquery, the AND of its lexemes as the
  // configuration reads them. Both read plain text: `&`, `|`, `!`, `<->`,
  // `:*` and quotes stay text, never operators.
  const tsquery =
    query.kind === 'keywords'
      ? query.keywords
          .map(
            (keyword) =>
              `phraseto_tsquery(${regconfig}, ${bind(parameters, keyword)})`,
          )
          .join(' && ')
      : `plainto_tsquery(${regconfig}, ${bind(parameters, query.text)})`;
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
