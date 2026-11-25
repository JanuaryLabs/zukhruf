import type {
  QueryBundle,
  QueryType,
  RetrieveOptions,
  Retriever,
  ScoredPassage,
} from '../index.ts';

/**
 * The query bundle of a host adapter for a live source with its own search
 * syntax, such as PubMed's Entrez term (ADR 0013).
 */
export type EntrezQueryBundle = QueryBundle & { readonly entrez: string };

/**
 * A host adapter for a live source cannot run in CI. This retriever records
 * each query it gets and gives its passages, in their order, with the scores
 * 1, 1/2, 1/3 and so on. The text of each passage is its id.
 */
export class RecordingRetriever<
  Q extends QueryType = QueryType,
> implements Retriever<Q> {
  readonly queries: Q[] = [];
  readonly #ids: readonly string[];

  constructor(ids: readonly string[]) {
    this.#ids = ids;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    this.queries.push(query);
    return this.#ids.slice(0, options.topK ?? 10).map((id, index) => ({
      passage: {
        id,
        text: id,
        source: `source-${id}`,
        seq: 0,
        start: 0,
        end: id.length,
        metadata: {},
      },
      score: 1 / (index + 1),
    }));
  }
}
