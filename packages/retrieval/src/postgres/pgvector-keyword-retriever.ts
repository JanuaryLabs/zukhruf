import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordQueryOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { identifier } from '../sql/identifier.ts';
import { AllWords, type PostgresMatch } from './postgres-match.ts';
import {
  type PostgresPassageStore,
  contractOf,
} from './postgres-passage-store.ts';

/**
 * How `PgvectorKeywordRetriever` matches the words of a query, under
 * Meilisearch's name, `matchingStrategy` (ADR 0018): `{ strategy: 'all' }`
 * finds the passages that hold every word, as `plainto_tsquery` joins them.
 * Postgres has no OR: `ts_rank_cd` has no IDF and ranks every matched row, so
 * an OR cannot be ranked well or in time at scale. Each member holds only the
 * fields that mean something for it, so the Postgres forms that follow have
 * their place.
 */
export type PostgresMatching = { readonly strategy: 'all' };

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
  readonly #match: PostgresMatch<M>;

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
    /** How the words of the query match: `{ strategy: 'all' }` when absent. */
    readonly matching?: PostgresMatching;
  }) {
    const { session, passages, metadata } = contractOf(options.store);
    const index = {
      session,
      passages,
      metadata,
      column: identifier(options.index.column),
      configuration: options.index.configuration ?? 'english',
    };
    const { strategy } = options.matching ?? { strategy: 'all' };
    switch (strategy) {
      case 'all':
        this.#match = new AllWords(index);
        break;
      default:
        throw new RangeError(
          `The strategy of matching is 'all', not ${String(strategy satisfies never)}`,
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
