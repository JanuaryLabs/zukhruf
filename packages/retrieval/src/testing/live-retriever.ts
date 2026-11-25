import type {
  Passage,
  QueryType,
  RetrievalResult,
  RetrieveOptions,
  Retriever,
  RetrieverUnavailableError,
} from '../index.ts';

/**
 * A host adapter for a live source that gives an order and no score, such as
 * a web search or PubMed's Best Match (ADR 0016), and that names the
 * failures it is given, as a host's own fusion does (ADR 0014). It cannot run
 * in CI, so it gives its passages in their order, without a score and
 * without source, seq, start and end (ADR 0015). The text of each passage is
 * its id. It records each query it gets.
 */
export class LiveRetriever<
  in out Q extends QueryType = QueryType,
> implements Retriever<Q, Passage> {
  readonly queries: Q[] = [];
  readonly #ids: readonly string[];
  readonly #failures: ReadonlyMap<string, RetrieverUnavailableError>;

  constructor(
    ids: readonly string[],
    failures: ReadonlyMap<string, RetrieverUnavailableError> = new Map(),
  ) {
    this.#ids = ids;
    this.#failures = failures;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions<Passage> = {},
  ): Promise<RetrievalResult<Passage>> {
    this.queries.push(query);
    return {
      passages: this.#ids
        .slice(0, options.topK ?? 10)
        .map((id) => ({ passage: { id, text: id, metadata: {} } })),
      failures: this.#failures,
    };
  }
}
