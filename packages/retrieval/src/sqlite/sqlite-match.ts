import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { Metadata, StoredPassage } from '../passage.ts';
import type { KeywordQuery } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { ScoredPassage } from '../scored-passage.ts';
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
  ): RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>;
}

/** A passage matches when it holds every term: the implicit operator of FTS5. */
export class AndMatch<M extends Metadata> implements SqliteMatch<M> {
  readonly #index: Fts5Index<M>;

  constructor(index: Fts5Index<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
    return bm25(this.#index, ftsPhrases(termsOf(query)).join(' AND '), options);
  }
}

/** A passage matches when it holds any term. */
export class OrMatch<M extends Metadata> implements SqliteMatch<M> {
  readonly #index: Fts5Index<M>;

  constructor(index: Fts5Index<M>) {
    this.#index = index;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
    return bm25(this.#index, ftsPhrases(termsOf(query)).join(' OR '), options);
  }
}

/**
 * Common terms (Lucene `CommonTermsQuery`, Elasticsearch `cutoff_frequency`):
 * the terms in at most `cutoff` passages find the passages, and the terms in
 * more only add to the bm25 of those passages, as the FTS5 query
 * `(rare OR) AND (all OR)`; a query of only common terms runs as their AND.
 * A term that no passage holds is left out, since it can only empty an AND.
 * The count bounds the rows by construction, which SQLite needs: `node:sqlite`
 * runs a statement synchronously and cannot interrupt it (ADR 0018).
 */
export class CommonTermsMatch<M extends Metadata> implements SqliteMatch<M> {
  readonly #index: Fts5Index<M>;
  readonly #cutoff: number;

  /** `cutoff` is a count of passages (1 or more) or a share of them (under 1). */
  constructor(index: Fts5Index<M>, cutoff: number) {
    this.#index = index;
    this.#cutoff = cutoff;
  }

  retrieve(
    query: KeywordQuery,
    options: RetrieveOptions<StoredPassage<M>>,
  ): RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
    const { database, index } = this.#index;
    const cutoff =
      this.#cutoff >= 1
        ? this.#cutoff
        : this.#cutoff * passageCount(this.#index);
    // Whether a term is common is a trial of its own phrase, not a lookup
    // through a guessed tokenizer, and it reads at most cutoff + 1 rowids.
    const counted = database.prepare(
      `SELECT count(*) AS "n" FROM (SELECT 1 FROM ${index} WHERE ${index} MATCH ? LIMIT ?)`,
    );
    // No black-box test can see this LIMIT, so none catches its removal; the
    // 20,000/20,001 boundary test proves the bound is correct.
    const limit = Math.floor(cutoff) + 1;
    const counts = new Map<string, number>();
    const countOf = (phrase: string): number => {
      const known = counts.get(phrase);
      if (known !== undefined) return known;
      const n = Number(counted.get(phrase, limit)?.['n']);
      counts.set(phrase, n);
      return n;
    };
    const held = ftsPhrases(termsOf(query)).filter(
      (phrase) => countOf(phrase) > 0,
    );
    if (held.length === 0) return { passages: [], failures: new Map() };
    const rare = held.filter((phrase) => countOf(phrase) <= cutoff);
    if (rare.length === 0) {
      return bm25(this.#index, held.join(' AND '), options);
    }
    if (rare.length === held.length) {
      return bm25(this.#index, held.join(' OR '), options);
    }
    const match = `(${rare.join(' OR ')}) AND (${held.join(' OR ')})`;
    return bm25(this.#index, match, options);
  }
}

/**
 * The number of passages that the index holds, for a share cutoff. Each
 * retrieve with a share runs this `count(*)`, which reads the whole table on
 * external content.
 */
const passageCount = ({ database, index }: Fts5Index<Metadata>): number =>
  Number(database.prepare(`SELECT count(*) AS "n" FROM ${index}`).get()?.['n']);

/** The passages that the FTS5 query `match` finds, best `-bm25()` first. */
function bm25<M extends Metadata>(
  { database, passages, index, metadata }: Fts5Index<M>,
  match: string,
  options: RetrieveOptions<StoredPassage<M>>,
): RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
  if (match === '') return { passages: [], failures: new Map() };
  const parameters: SQLInputValue[] = [match];
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
 * Each term as an FTS5 phrase, with a `"` in it doubled, so no term of the
 * query is FTS5 syntax: `-`, `:`, `*`, `NEAR` and `OR` stay words
 * (sqlite.org/fts5.html §3), as text2sql's `toFtsQuery` quotes them (#5410).
 */
const ftsPhrases = (terms: readonly string[]): string[] =>
  terms.map((term) => `"${term.replaceAll('"', '""')}"`);

/**
 * What FTS5 matches, each one phrase: a keyword whole, so its words match
 * side by side and in order (ADR 0018), or each white-space word of a text,
 * since FTS5 has no free-text parser and a phrase gives the word to the
 * tokenizer of the index.
 */
const termsOf = (query: KeywordQuery): readonly string[] =>
  query.kind === 'keywords'
    ? query.keywords
    : query.text.split(/\s+/).filter((word) => word !== '');
