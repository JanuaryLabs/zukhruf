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
 * What a keyword retriever matches: the whole keywords of the bundle, or the
 * text of `query` when it has none (ADR 0013). How a keyword or a text
 * becomes a match is each engine's.
 */
export type KeywordQuery =
  | {
      readonly kind: 'keywords';
      readonly keywords: readonly [string, ...string[]];
    }
  | { readonly kind: 'text'; readonly text: string };

/**
 * The first phase of a keyword search (Split Phase, Fowler): which text the
 * retriever matches; each engine's retriever is the second phase, which
 * tokenizes it. A blank keyword is dropped. A `keywords` of no word is a
 * caller bug, as an empty list is, so it throws a `RangeError` (ADR 0013).
 */
export const keywordQueryOf = (query: QueryType): KeywordQuery => {
  const bundle = bundleOf(query);
  if (bundle.keywords === undefined) {
    return { kind: 'text', text: bundle.query };
  }
  const [first, ...rest] = bundle.keywords.filter((keyword) =>
    /\S/.test(keyword),
  );
  if (first === undefined) {
    throw new RangeError(
      `The keywords of a query bundle hold no word: got ${JSON.stringify(bundle.keywords)}`,
    );
  }
  return { kind: 'keywords', keywords: [first, ...rest] };
};

/** The texts that an embedding retriever embeds: `customEmbeddings`, or `[query]`. */
export const embeddingsOf = (
  query: QueryType,
): readonly [string, ...string[]] => {
  const bundle = bundleOf(query);
  return bundle.customEmbeddings ?? [bundle.query];
};
