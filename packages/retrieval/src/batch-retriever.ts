import type { Passage } from './passage.ts';
import type { QueryType } from './query-bundle.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { Retriever } from './retriever.ts';

/** A retriever that also searches many queries in one call (ADR 0003). */
export interface BatchRetriever<P extends Passage = Passage> extends Retriever<
  QueryType,
  P
> {
  /**
   * Gives one retrieval result for each query, in the order of the queries,
   * as Elasticsearch's `_msearch` gives one response for each (ADR 0014).
   */
  readonly retrieveMany: (
    queries: readonly QueryType[],
    options?: RetrieveOptions<P>,
  ) => Promise<RetrievalResult<P>[]>;
}
