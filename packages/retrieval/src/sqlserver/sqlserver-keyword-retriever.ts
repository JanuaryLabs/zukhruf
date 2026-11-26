import { callTopK } from '../count.ts';
import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordQueryOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import type { ScoredPassage } from '../scored-passage.ts';
import {
  ContainsAll,
  ContainsAny,
  FreeText,
  type SqlServerMatch,
} from './sqlserver-match.ts';
import {
  type SqlServerPassageStore,
  contractOf,
} from './sqlserver-passage-store.ts';

/**
 * How `SqlServerKeywordRetriever` matches the words of a query, under
 * Microsoft's T-SQL names (ADR 0018). `{ predicate: 'FREETEXT' }`, the
 * default, is SQL Server's natural-language form: `FREETEXTTABLE` over a
 * text, ranked by BM25, and an `ISABOUT` of each keyword with its inflections.
 * `{ predicate: 'CONTAINS', operator }` is the `CONTAINS` predicate with its
 * Boolean operator, `'AND'` for the passages that hold every word and `'OR'`
 * for those that hold any. Each member holds only the fields that mean
 * something for it: FREETEXT has no operator.
 */
export type SqlServerMatching =
  | { readonly predicate: 'FREETEXT' }
  | { readonly predicate: 'CONTAINS'; readonly operator: 'AND' | 'OR' };

/**
 * Ranks the passages by SQL Server full-text search over the keyword index
 * that elt writes: a full-text index on the `[text]` column of a base table
 * whose full-text key is the passage id (ADR 0004). The search is
 * `FREETEXTTABLE` or `CONTAINSTABLE`, and the score is its `RANK`, which is
 * higher for a better match (ADR 0005). It matches each keyword of
 * `keywords` as one phrase, or `query` when the bundle has none (ADR 0013,
 * ADR 0018).
 * It gives the passages with the metadata that its store reads (ADR 0015).
 */
export class SqlServerKeywordRetriever<
  // `in out M`: TypeScript cannot measure M through the filter's mapped keys,
  // and a class method checks its parameters both ways (ADR 0015).
  in out M extends Metadata = Metadata,
> implements Retriever<
  QueryType,
  StoredPassage<M>,
  ScoredPassage<StoredPassage<M>>
> {
  readonly #match: SqlServerMatch<M>;

  constructor(options: {
    /** The store of the passages, whose session and schema the search uses. */
    readonly store: SqlServerPassageStore<M>;
    /** The keyword index as elt writes it. */
    readonly index: {
      /** The base table, in the schema of the store, that holds the full-text index on `[text]` with the passage id as its key. */
      readonly table: string;
    };
    /** How the words of the query match: `{ predicate: 'FREETEXT' }` when absent. */
    readonly matching?: SqlServerMatching;
  }) {
    const contract = contractOf(options.store);
    const index = {
      session: contract.session,
      passages: contract.passages,
      metadata: contract.metadata,
      table: contract.relation(options.index.table),
    };
    const matching: SqlServerMatching = options.matching ?? {
      predicate: 'FREETEXT',
    };
    const { predicate } = matching;
    if (predicate === 'FREETEXT') {
      this.#match = new FreeText(index);
      return;
    }
    if (predicate !== 'CONTAINS') {
      throw new RangeError(
        `The predicate of matching is 'FREETEXT' or 'CONTAINS', not ${String(predicate satisfies never)}`,
      );
    }
    const { operator } = matching;
    switch (operator) {
      case 'AND':
        this.#match = new ContainsAll(index);
        break;
      case 'OR':
        this.#match = new ContainsAny(index);
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
  ): Promise<
    RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>
  > {
    const checked = { ...options, topK: callTopK(options.topK) };
    options.signal?.throwIfAborted();
    return this.#match.retrieve(keywordQueryOf(query), checked);
  }
}
