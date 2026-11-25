import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordQueryOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { identifier } from '../sql/identifier.ts';
import { AllWords, AnyWord, type PostgresMatch } from './postgres-match.ts';
import {
  type PostgresPassageStore,
  contractOf,
} from './postgres-passage-store.ts';

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
    /** How the words of the query join: 'AND', as `plainto_tsquery` joins them, when absent. */
    readonly operator?: 'AND' | 'OR';
  }) {
    const { session, passages, metadata } = contractOf(options.store);
    const index = {
      session,
      passages,
      metadata,
      column: identifier(options.index.column),
      configuration: options.index.configuration ?? 'english',
    };
    const operator = options.operator ?? 'AND';
    switch (operator) {
      case 'AND':
        this.#match = new AllWords(index);
        break;
      case 'OR':
        this.#match = new AnyWord(index);
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
