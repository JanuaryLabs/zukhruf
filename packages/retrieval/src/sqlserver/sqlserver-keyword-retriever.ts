import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordsOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { where } from '../sql/where.ts';
import { binary } from './binary.ts';
import { bind } from './bind.ts';
import { dialect } from './dialect.ts';
import { passage, passageJson } from './passage-row.ts';
import {
  type SqlServerPassageStore,
  contractOf,
} from './sqlserver-passage-store.ts';
import type { SqlServerSession } from './sqlserver-session.ts';

/**
 * Ranks the passages by SQL Server full-text search over the keyword index
 * that elt writes: a full-text index on the `[text]` column of a base table
 * whose full-text key is the passage id (ADR 0004). The search is
 * `CONTAINSTABLE`, and the score is its `RANK`, which is higher for a better
 * match (ADR 0005). It matches the words of `keywords`, or of `query` when
 * the bundle has none (ADR 0013).
 * It gives the passages with the metadata that its store reads (ADR 0015).
 */
export class SqlServerKeywordRetriever<
  // `in out M`: TypeScript cannot measure M through the filter's mapped keys,
  // and a class method checks its parameters both ways (ADR 0015).
  in out M extends Metadata = Metadata,
> implements Retriever<QueryType, StoredPassage<M>> {
  readonly #session: SqlServerSession;
  readonly #passages: string;
  readonly #metadata: (columns: Metadata) => M;
  readonly #index: string;
  readonly #operator: 'AND' | 'OR';

  constructor(options: {
    /** The store of the passages, whose session and schema the search uses. */
    readonly store: SqlServerPassageStore<M>;
    /** The keyword index as elt writes it. */
    readonly index: {
      /** The base table, in the schema of the store, that holds the full-text index on `[text]` with the passage id as its key. */
      readonly table: string;
    };
    /** How the words of the query join: 'AND' when absent. */
    readonly operator?: 'AND' | 'OR';
  }) {
    const contract = contractOf(options.store);
    this.#session = contract.session;
    this.#passages = contract.passages;
    this.#metadata = contract.metadata;
    this.#index = contract.relation(options.index.table);
    this.#operator = options.operator ?? 'AND';
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<StoredPassage<M>> = {},
  ): Promise<RetrievalResult<StoredPassage<M>>> {
    options.signal?.throwIfAborted();
    const words = phrases(keywordsOf(query));
    if (words.length === 0) return { passages: [], failures: new Map() };
    const parameters: Record<string, unknown> = {};
    // A condition longer than 4,000 characters reaches the caller as SQL
    // Server's error 4110: the driver binds it as NVARCHAR(MAX), which
    // CONTAINSTABLE refuses.
    const condition = bind(parameters, words.join(` ${this.#operator} `));
    const filter = where(dialect, options.filter, parameters);
    const topK = bind(parameters, options.topK ?? 10);
    const rows = await this.#session.query(
      `
      SELECT TOP (${topK}) k.[RANK] AS [score], ${passageJson} AS [passage]
      FROM CONTAINSTABLE(${this.#index}, [text], ${condition}) k
      JOIN ${this.#passages} p ON p.[id] = k.[KEY] ${binary}
      WHERE ${filter}
      ORDER BY k.[RANK] DESC, p.[id] ${binary}`,
      parameters,
      options.signal === undefined ? {} : { signal: options.signal },
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
