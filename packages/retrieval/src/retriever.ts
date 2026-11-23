import type { RetrieveOptions } from './retrieve-options.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * The port of the package: any source can implement it (ADR 0002). It gives
 * scored passages, best first.
 */
export interface Retriever {
  retrieve(query: string, options?: RetrieveOptions): Promise<ScoredPassage[]>;
}
