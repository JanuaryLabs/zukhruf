import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordQueryOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import { identifier } from '../sql/identifier.ts';
import {
  AndMatch,
  CommonTermsMatch,
  OrMatch,
  type SqliteMatch,
} from './sqlite-match.ts';
import { type SqlitePassageStore, contractOf } from './sqlite-passage-store.ts';

/**
 * How `SqliteBM25Retriever` matches the terms of a query, under
 * Elasticsearch's names for a `match` query's `operator` and
 * `cutoff_frequency` (ADR 0018): `{ operator: 'AND' }` finds the passages
 * that hold every term, the implicit operator of FTS5; `{ operator: 'OR' }`
 * finds those that hold any term, and bm25 ranks the rarer terms first. Each
 * member holds only the fields that mean something for it.
 */
export type SqliteMatching =
  | {
      readonly operator: 'OR';
      /**
       * A term in more passages than this only adds to the score of the
       * passages that rarer terms find, and a query of only such terms runs
       * as their AND (Lucene `CommonTermsQuery`). A count of passages (1 or
       * more) or a share of the passages (under 1). Absent: every term
       * matches.
       */
      readonly cutoffFrequency?: number;
    }
  | { readonly operator: 'AND' };

/**
 * Ranks the passages by FTS5 `bm25()` over the keyword index that elt writes:
 * an FTS5 table with the passages as its external content (ADR 0004). The
 * score is `-bm25()`, so a better match has a higher score (ADR 0005). It
 * matches each keyword of `keywords` as one FTS5 phrase, or the words of
 * `query` when the bundle has none (ADR 0013, ADR 0018). It gives the
 * passages with the metadata that its store reads (ADR 0015).
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
    /**
     * How the terms of the query match: `{ operator: 'OR', cutoffFrequency:
     * 20_000 }` when absent, so below 20,000 passages it is plain OR.
     */
    readonly matching?: SqliteMatching;
  }) {
    const { database, passages, metadata } = contractOf(options.store);
    const index = {
      database,
      passages,
      metadata,
      index: identifier(options.index),
    };
    const matching: SqliteMatching = options.matching ?? {
      operator: 'OR',
      cutoffFrequency: 20_000,
    };
    const { operator } = matching;
    switch (operator) {
      case 'AND':
        this.#match = new AndMatch(index);
        break;
      case 'OR':
        this.#match =
          matching.operator === 'OR' && matching.cutoffFrequency !== undefined
            ? new CommonTermsMatch(index, cutoffOf(matching.cutoffFrequency))
            : new OrMatch(index);
        break;
      default:
        throw new RangeError(
          `The operator of matching is 'AND' or 'OR', not ${String(operator satisfies never)}`,
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

/** A cutoff the type cannot refuse: NaN, an infinity, zero or less. */
function cutoffOf(cutoffFrequency: number): number {
  if (Number.isFinite(cutoffFrequency) && cutoffFrequency > 0) {
    return cutoffFrequency;
  }
  throw new RangeError(
    `The cutoffFrequency of matching is a positive finite number, not ${String(cutoffFrequency)}`,
  );
}
