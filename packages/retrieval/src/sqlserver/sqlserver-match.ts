import type { Metadata, StoredPassage } from '../passage.ts';
import type { KeywordQuery } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import { where } from '../sql/where.ts';
import { binary } from './binary.ts';
import { bind } from './bind.ts';
import { dialect } from './dialect.ts';
import { passage, passageJson } from './passage-row.ts';
import type { SqlServerSession } from './sqlserver-session.ts';

/** The full-text indexed table that a match searches, and the passages it indexes. */
export interface FullTextIndex<M extends Metadata> {
  readonly session: SqlServerSession;
  readonly passages: string;
  readonly metadata: (columns: Metadata) => M;
  readonly table: string;
}

/**
 * Strategy (GoF): one way to match a keyword query in SQL Server full-text
 * search and rank the passages it finds; `SqlServerKeywordRetriever` picks
 * one in its constructor.
 */
export interface SqlServerMatch<M extends Metadata> {
  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<RetrievalResult<StoredPassage<M>>>;
}

/** A passage matches when it holds every phrase: they join with `AND`. */
export class ContainsAll<M extends Metadata> implements SqlServerMatch<M> {
  readonly #index: FullTextIndex<M>;

  constructor(index: FullTextIndex<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<RetrievalResult<StoredPassage<M>>> {
    return containsTable(this.#index, query, 'AND', options);
  }
}

/** A passage matches when it holds any phrase: they join with `OR`. */
export class ContainsAny<M extends Metadata> implements SqlServerMatch<M> {
  readonly #index: FullTextIndex<M>;

  constructor(index: FullTextIndex<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<RetrievalResult<StoredPassage<M>>> {
    return containsTable(this.#index, query, 'OR', options);
  }
}

/**
 * SQL Server's natural-language form: a text goes whole to `FREETEXTTABLE`,
 * whose word breaker reads it, adds the inflections of its words, ORs them
 * and ranks with Okapi BM25, so CONTAINS syntax in it is text. FREETEXT has
 * no phrase, so each keyword is a `FORMSOF(INFLECTIONAL, "…")` phrase of an
 * `ISABOUT` in `CONTAINSTABLE`, which a passage that holds any keyword
 * matches. With no filter, when the passages are the table of the index,
 * `top_n_by_rank` is the call's `topK`, so the engine stops ranking there;
 * with a filter, or passages that are another relation such as a view, it is
 * left out, because it cuts before the join and the filter and would give
 * fewer than `topK` passages (ADR 0018).
 */
export class FreeText<M extends Metadata> implements SqlServerMatch<M> {
  readonly #index: FullTextIndex<M>;

  constructor(index: FullTextIndex<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<RetrievalResult<StoredPassage<M>>> {
    const cut = options.filter === undefined;
    if (query.kind === 'text') {
      // A blank text is SQL Server's error 7645, and the session rejects
      // with its host's driver error, whose shape the package does not
      // know, so the check comes before the statement.
      if (!/[\p{L}\p{N}]/u.test(query.text)) return nothing();
      return ranked(this.#index, 'FREETEXTTABLE', query.text, cut, options);
    }
    const terms = phrases(query.keywords);
    if (terms.length === 0) return nothing();
    const condition = `ISABOUT(${terms
      .map((term) => `FORMSOF(INFLECTIONAL, ${term})`)
      .join(', ')})`;
    return ranked(this.#index, 'CONTAINSTABLE', condition, cut, options);
  }
}

const nothing = <M extends Metadata>(): Promise<
  RetrievalResult<StoredPassage<M>>
> => Promise.resolve({ passages: [], failures: new Map() });

/**
 * `CONTAINSTABLE` with each term one phrase, joined by `operator`; the score
 * is its `RANK`.
 */
function containsTable<M extends Metadata>(
  index: FullTextIndex<M>,
  query: KeywordQuery,
  operator: 'AND' | 'OR',
  options: RetrieveOptions<StoredPassage<M>>,
): Promise<RetrievalResult<StoredPassage<M>>> {
  const terms = phrases(termsOf(query));
  if (terms.length === 0) return nothing();
  return ranked(
    index,
    'CONTAINSTABLE',
    terms.join(` ${operator} `),
    false,
    options,
  );
}

/**
 * The passages of a full-text table function, best first by its `RANK`,
 * which is the score, and a tie in binary order of the id. With `cut`, the
 * function's `top_n_by_rank` is the call's `topK` when the engine finds that
 * the passages are the table of the index: a view of fewer rows would lose
 * matches after the cut. Which tied matches survive the cut follows the
 * engine (ADR 0018).
 */
async function ranked<M extends Metadata>(
  index: FullTextIndex<M>,
  from: 'CONTAINSTABLE' | 'FREETEXTTABLE',
  search: string,
  cut: boolean,
  options: RetrieveOptions<StoredPassage<M>>,
): Promise<RetrievalResult<StoredPassage<M>>> {
  const { session, passages, metadata, table } = index;
  const parameters: Record<string, unknown> = {};
  // A condition longer than 4,000 characters reaches the caller as SQL
  // Server's error 4110: the driver binds it as NVARCHAR(MAX), which
  // CONTAINSTABLE and FREETEXTTABLE refuse.
  const condition = bind(parameters, search);
  const filter = where(dialect, options.filter, parameters);
  const topK = bind(parameters, options.topK ?? 10);
  const matches = (top: string) =>
    `SELECT [KEY], [RANK] FROM ${from}(${table}, [text], ${condition}${top})`;
  // `top_n_by_rank` takes a literal or a variable, never an expression, so
  // the engine picks one branch by a startup filter on its own answer.
  const same = `IIF(OBJECT_ID(${bind(parameters, passages)}) = OBJECT_ID(${bind(parameters, table)}), 1, 0)`;
  const source = cut
    ? `(${matches(`, ${topK}`)} WHERE ${same} = 1 UNION ALL ${matches('')} WHERE ${same} = 0)`
    : `(${matches('')})`;
  const rows = await session.query(
    `
      SELECT TOP (${topK}) k.[RANK] AS [score], ${passageJson} AS [passage]
      FROM ${source} k
      JOIN ${passages} p ON p.[id] = k.[KEY] ${binary}
      WHERE ${filter}
      ORDER BY k.[RANK] DESC, p.[id] ${binary}`,
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
 * Each term as one CONTAINS phrase, `"…"`. A `"` would end the
 * phrase and a `*` before its end makes a prefix term, so each becomes a
 * space, which the word breaker reads as it reads the punctuation. A term
 * with no letter or digit makes no token and acts as a noise word, which
 * gives an AND no rows, so it is dropped. `AND`, `OR`, `NEAR`, `&`, `|`, `!`,
 * `~` and parentheses inside a phrase are text.
 */
function phrases(terms: readonly string[]): string[] {
  return terms
    .map((term) => term.replaceAll(/["*]/g, ' ').trim())
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term}"`);
}

/**
 * What CONTAINS matches, each one phrase: a keyword whole, so its words match
 * side by side and in order (ADR 0018), or each white-space word of a text.
 */
const termsOf = (query: KeywordQuery): readonly string[] =>
  query.kind === 'keywords'
    ? query.keywords
    : query.text.split(/\s+/).filter((word) => word !== '');
