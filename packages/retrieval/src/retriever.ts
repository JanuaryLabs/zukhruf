import type { QueryType } from './query-bundle.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * The port of the package: any source can implement it (ADR 0002). It gives
 * scored passages, best first. A retriever that needs a field of its own
 * declares it in its query type, `QueryBundle & { readonly entrez: string }`,
 * and then takes no string (ADR 0013).
 */
export interface Retriever<in Q extends QueryType = QueryType> {
  // A function-typed property, not a method: TypeScript checks the parameter
  // of a method both ways, so a retriever that needs its own field would pass
  // as a plain one (ADR 0013).
  readonly retrieve: (
    query: Q,
    options?: RetrieveOptions,
  ) => Promise<ScoredPassage[]>;
}
