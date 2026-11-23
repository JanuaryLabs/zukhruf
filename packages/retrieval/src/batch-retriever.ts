import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/** A retriever that also searches many queries in one call (ADR 0003). */
export interface BatchRetriever extends Retriever {
  /** Gives one result list for each query, in the order of the queries. */
  retrieveMany(
    queries: readonly string[],
    options?: RetrieveOptions,
  ): Promise<ScoredPassage[][]>;
}
