import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordQueryOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { identifier } from '../sql/identifier.ts';
import {
  AllWords,
  DropMostFrequent,
  type PostgresMatch,
} from './postgres-match.ts';
import {
  type PostgresPassageStore,
  contractOf,
} from './postgres-passage-store.ts';

/**
 * How `PgvectorKeywordRetriever` matches the words of a query, under
 * Meilisearch's `matchingStrategy` and Typesense's `drop_tokens_threshold`
 * (ADR 0018). `{ strategy: 'frequency' }` finds the passages that hold every
 * word and, while fewer than `dropTokensThreshold` passages match, drops the
 * most frequent word and tries again; a passage scores the number of the
 * query's words it holds plus `ts_rank(index, OR of the words, 33)`.
 * `{ strategy: 'all' }` finds the passages that hold every word, ranked by
 * `ts_rank_cd`. Postgres has no OR: it has no IDF and ranks every matched
 * row, so an OR cannot be ranked well or in time at scale.
 */
export type PostgresMatching =
  | {
      readonly strategy: 'frequency';
      /** Drop the most frequent word while fewer than this many passages match: 10 when absent. */
      readonly dropTokensThreshold?: number;
    }
  | { readonly strategy: 'all' };

/**
 * Ranks the passages by Postgres full-text search over the keyword index
 * that elt writes: a `tsvector` column of the passages, `to_tsvector(configuration,
 * text)`, with a GIN index (ADR 0004). The score is higher for a better match
 * (ADR 0005). It matches each keyword of `keywords` as one
 * `phraseto_tsquery`, or the lexemes of `query` in the configuration when the
 * bundle has none (ADR 0013, ADR 0018).
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
    /** How the words of the query match: `{ strategy: 'frequency', dropTokensThreshold: 10 }` when absent. */
    readonly matching?: PostgresMatching;
  }) {
    const { session, passages, metadata } = contractOf(options.store);
    const index = {
      session,
      passages,
      metadata,
      column: identifier(options.index.column),
      columnName: options.index.column,
      configuration: options.index.configuration ?? 'english',
    };
    const matching: PostgresMatching = options.matching ?? {
      strategy: 'frequency',
      dropTokensThreshold: 10,
    };
    const { strategy } = matching;
    switch (strategy) {
      case 'all':
        this.#match = new AllWords(index);
        break;
      case 'frequency':
        this.#match = new DropMostFrequent(
          index,
          thresholdOf(matching.dropTokensThreshold ?? 10),
        );
        break;
      default:
        throw new RangeError(
          `The strategy of matching is 'all' or 'frequency', not ${String(strategy satisfies never)}`,
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

/** A threshold the type cannot refuse: NaN, an infinity, zero or less. */
function thresholdOf(dropTokensThreshold: number): number {
  if (Number.isFinite(dropTokensThreshold) && dropTokensThreshold > 0) {
    return dropTokensThreshold;
  }
  throw new RangeError(
    `The dropTokensThreshold of matching is a positive finite number, not ${String(dropTokensThreshold)}`,
  );
}
