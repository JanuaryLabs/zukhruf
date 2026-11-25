/**
 * One search request, after LlamaIndex's `QueryBundle`: the information need,
 * and the text of each kind of search that needs other words (ADR 0013).
 */
export type QueryBundle = {
  /**
   * The information need. Rerank, MaximalMarginalRelevance and the language
   * models of HydeRetriever and MultiQueryRetriever read it, and so does
   * every search that has no text of its own.
   */
  readonly query: string;
  /** What a keyword retriever matches: the words of `query` when absent (.NET `keywords`). */
  readonly keywords?: readonly [string, ...string[]];
  /**
   * What an embedding retriever embeds: it searches with the mean of their
   * vectors, and embeds `query` when absent (LlamaIndex.TS `customEmbeddings`).
   */
  readonly customEmbeddings?: readonly [string, ...string[]];
};

/** A query: a string is a query bundle with only `query` (LlamaIndex `QueryType`). */
export type QueryType = string | QueryBundle;

/**
 * The query bundle of a query: a string becomes `{ query }`, as LlamaIndex's
 * `retrieve` makes `QueryBundle(str)`.
 */
export const bundleOf = (query: QueryType): QueryBundle =>
  typeof query === 'string' ? { query } : query;

/** The information need of a query: the string, or the `query` of the bundle. */
export const needOf = (query: QueryType): string =>
  typeof query === 'string' ? query : query.query;

/**
 * The words that a keyword retriever quotes: the words of `keywords`, or of
 * `query` when the bundle has none.
 */
export const keywordsOf = (query: QueryType): string[] => {
  const bundle = bundleOf(query);
  return (bundle.keywords ?? [bundle.query])
    .flatMap((text) => text.split(/\s+/))
    .filter((word) => word !== '');
};

/** The texts that an embedding retriever embeds: `customEmbeddings`, or `[query]`. */
export const embeddingsOf = (
  query: QueryType,
): readonly [string, ...string[]] => {
  const bundle = bundleOf(query);
  return bundle.customEmbeddings ?? [bundle.query];
};
