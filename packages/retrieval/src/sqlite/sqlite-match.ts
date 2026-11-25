import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { Metadata, StoredPassage } from '../passage.ts';
import type { KeywordQuery } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import { where } from '../sql/where.ts';
import { dialect } from './dialect.ts';
import { passageRows } from './passage-rows.ts';

/** The FTS5 index that a match searches, and the passages it indexes. */
export interface Fts5Index<M extends Metadata> {
  readonly database: DatabaseSync;
  readonly passages: string;
  readonly index: string;
  readonly metadata: (columns: Metadata) => M;
}

/**
 * Strategy (GoF): one way to match a keyword query in FTS5 and rank the
 * passages it finds; `SqliteBM25Retriever` picks one in its constructor.
 */
export interface SqliteMatch<M extends Metadata> {
  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): RetrievalResult<StoredPassage<M>>;
}

/** A passage matches when it holds every word: the implicit operator of FTS5. */
export class AndMatch<M extends Metadata> implements SqliteMatch<M> {
  readonly #index: Fts5Index<M>;

  constructor(index: Fts5Index<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): RetrievalResult<StoredPassage<M>> {
    return bm25(this.#index, query, ' AND ', options);
  }
}

/** A passage matches when it holds any word. */
export class OrMatch<M extends Metadata> implements SqliteMatch<M> {
  readonly #index: Fts5Index<M>;

  constructor(index: Fts5Index<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): RetrievalResult<StoredPassage<M>> {
    return bm25(this.#index, query, ' OR ', options);
  }
}

/** The passages that match the words joined by `operator`, best `-bm25()` first. */
function bm25<M extends Metadata>(
  { database, passages, index, metadata }: Fts5Index<M>,
  query: KeywordQuery,
  operator: ' AND ' | ' OR ',
  options: RetrieveOptions<StoredPassage<M>>,
): RetrievalResult<StoredPassage<M>> {
  const words = wordsOf(query);
  if (words.length === 0) return { passages: [], failures: new Map() };
  const parameters: SQLInputValue[] = [ftsPhrases(words).join(operator)];
  const filter = where(dialect, options.filter, parameters);
  parameters.push(options.topK ?? 10);
  const statement = database.prepare(`
      SELECT -bm25(${index}) AS "score", p.*
      FROM ${index} JOIN ${passages} p ON p.rowid = ${index}.rowid
      WHERE ${index} MATCH ? AND ${filter}
      ORDER BY bm25(${index}), p."id"
      LIMIT ?`);
  return {
    passages: passageRows(statement, 1, parameters, metadata).map(
      ({ cells: [score], passage }) => ({
        passage,
        score: Number(score),
      }),
    ),
    failures: new Map(),
  };
}

/**
 * Each word as an FTS5 phrase, with a `"` in it doubled, so no word of the
 * query is FTS5 syntax: `-`, `:`, `*`, `NEAR` and `OR` stay words
 * (sqlite.org/fts5.html §3), as text2sql's `toFtsQuery` quotes them (#5410).
 */
const ftsPhrases = (words: readonly string[]): string[] =>
  words.map((word) => `"${word.replaceAll('"', '""')}"`);

/**
 * The white-space words of each keyword, or of the text: today's split, the
 * same on every engine until each one tokenizes its own way (#5669).
 */
const wordsOf = (query: KeywordQuery): string[] =>
  (query.kind === 'keywords' ? query.keywords : [query.text])
    .flatMap((text) => text.split(/\s+/))
    .filter((word) => word !== '');
