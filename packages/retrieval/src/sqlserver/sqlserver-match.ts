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

/** A passage matches when it holds every word: the phrases join with `AND`. */
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

/** A passage matches when it holds any word: the phrases join with `OR`. */
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
 * `CONTAINSTABLE` with each word one phrase, joined by `operator`; the score
 * is its `RANK`.
 */
async function containsTable<M extends Metadata>(
  index: FullTextIndex<M>,
  query: KeywordQuery,
  operator: 'AND' | 'OR',
  options: RetrieveOptions<StoredPassage<M>>,
): Promise<RetrievalResult<StoredPassage<M>>> {
  const { session, passages, metadata, table } = index;
  const words = phrases(wordsOf(query));
  if (words.length === 0) return { passages: [], failures: new Map() };
  const parameters: Record<string, unknown> = {};
  // A condition longer than 4,000 characters reaches the caller as SQL
  // Server's error 4110: the driver binds it as NVARCHAR(MAX), which
  // CONTAINSTABLE refuses.
  const condition = bind(parameters, words.join(` ${operator} `));
  const filter = where(dialect, options.filter, parameters);
  const topK = bind(parameters, options.topK ?? 10);
  const rows = await session.query(
    `
      SELECT TOP (${topK}) k.[RANK] AS [score], ${passageJson} AS [passage]
      FROM CONTAINSTABLE(${table}, [text], ${condition}) k
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
 * Each word as one CONTAINS phrase, `"…"`. A `"` would end the
 * phrase and a `*` before its end makes a prefix term, so each becomes a
 * space, which the word breaker reads as it reads the punctuation. A word
 * with no letter or digit makes no token and acts as a noise word, which
 * gives an AND no rows, so it is dropped. `AND`, `OR`, `NEAR`, `&`, `|`, `!`,
 * `~` and parentheses inside a phrase are text.
 */
function phrases(words: readonly string[]): string[] {
  return words
    .map((word) => word.replaceAll(/["*]/g, ' ').trim())
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .map((word) => `"${word}"`);
}

/**
 * The white-space words of each keyword, or of the text: today's split, the
 * same on every engine until each one tokenizes its own way (#5669).
 */
const wordsOf = (query: KeywordQuery): string[] =>
  (query.kind === 'keywords' ? query.keywords : [query.text])
    .flatMap((text) => text.split(/\s+/))
    .filter((word) => word !== '');
