import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordQueryOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { identifier } from '../sql/identifier.ts';
import { AndMatch, OrMatch, type SqliteMatch } from './sqlite-match.ts';
import { type SqlitePassageStore, contractOf } from './sqlite-passage-store.ts';

/**
 * Ranks the passages by FTS5 `bm25()` over the keyword index that elt writes:
 * an FTS5 table with the passages as its external content (ADR 0004). The
 * score is `-bm25()`, so a better match has a higher score (ADR 0005). It
 * matches the words of `keywords`, or of `query` when the bundle has none
 * (ADR 0013). It gives the passages with the metadata that its store
 * reads (ADR 0015).
 */
export class SqliteBM25Retriever<
  // `in out M`: TypeScript cannot measure M through the filter's mapped keys,
  // and a class method checks its parameters both ways (ADR 0015).
  in out M extends Metadata = Metadata,
> implements Retriever<QueryType, StoredPassage<M>> {
  readonly #match: SqliteMatch<M>;

  constructor(options: {
    /** The store of the passages, whose connection the search runs on. */
    readonly store: SqlitePassageStore<M>;
    /** The FTS5 table over the passages, in the database of the store. */
    readonly index: string;
    /** How the words of the query join: 'AND', the implicit operator of FTS5, when absent. */
    readonly operator?: 'AND' | 'OR';
  }) {
    const { database, passages, metadata } = contractOf(options.store);
    const index = {
      database,
      passages,
      metadata,
      index: identifier(options.index),
    };
    const operator = options.operator ?? 'AND';
    switch (operator) {
      case 'AND':
        this.#match = new AndMatch(index);
        break;
      case 'OR':
        this.#match = new OrMatch(index);
        break;
      default:
        throw new RangeError(
          `The operator is 'AND' or 'OR', not ${String(operator satisfies never)}`,
        );
    }
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<StoredPassage<M>> = {},
  ): Promise<RetrievalResult<StoredPassage<M>>> {
    options.signal?.throwIfAborted();
    return this.#match.retrieve(keywordQueryOf(query), options);
  }
}
