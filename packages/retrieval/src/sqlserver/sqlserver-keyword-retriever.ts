import type { Metadata, StoredPassage } from '../passage.ts';
import { type QueryType, keywordQueryOf } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { Retriever } from '../retriever.ts';
import {
  ContainsAll,
  ContainsAny,
  type SqlServerMatch,
} from './sqlserver-match.ts';
import {
  type SqlServerPassageStore,
  contractOf,
} from './sqlserver-passage-store.ts';

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
  readonly #match: SqlServerMatch<M>;

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
    const index = {
      session: contract.session,
      passages: contract.passages,
      metadata: contract.metadata,
      table: contract.relation(options.index.table),
    };
    const operator = options.operator ?? 'AND';
    switch (operator) {
      case 'AND':
        this.#match = new ContainsAll(index);
        break;
      case 'OR':
        this.#match = new ContainsAny(index);
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
