/**
 * One search request, after LlamaIndex's `QueryBundle`: the information need,
 * and the text of each kind of search that needs other words (ADR 0013).
 */
export type QueryBundle = {
  /**
   * The information need. RerankRetriever, EmbeddingRerankRetriever,
   * MaximalMarginalRelevance and the language models of HydeRetriever and
   * MultiQueryRetriever read it, and so does every search that has no text
   * of its own.
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
 * The `query` of a bundle from a caller with no types may be no string at
 * all; `/\S/` would read `undefined` or `null` as the word 'undefined' or
 * 'null', so a non-string is a `RangeError` before any word test.
 */
const queryText = (query: unknown): string => {
  if (typeof query !== 'string') {
    throw new RangeError(
      `The query of a query bundle is not a string: got ${JSON.stringify(query)}`,
    );
  }
  return query;
};

/**
 * A caller with no types may pass a list field as no list at all, or with a
 * non-string in it; `every` alone throws a `TypeError` on a non-list.
 */
const isListOfStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * An information need that a model reads: one that is empty or white space
 * only has no meaning to rank, embed or expand, so it is a caller bug and a
 * `RangeError`, by the rule of a blank keyword (ADR 0013). Each object that
 * gives the need to a model checks it at its entry, before any retriever or
 * model call: RerankRetriever, EmbeddingRerankRetriever, HydeRetriever,
 * MultiQueryRetriever, MaximalMarginalRelevance, and the SQLite, Postgres and
 * SQL Server embedding retrievers through `embeddingsOf`, before they read
 * the stored identities. `needOf` alone does not, since `ContextWindow` reads
 * no need.
 */
export const wordedNeed = (need: string): string => {
  queryText(need);
  if (!/\S/.test(need)) {
    throw new RangeError(
      `The query of a query bundle holds no word: got ${JSON.stringify(need)}`,
    );
  }
  return need;
};

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
    return { kind: 'text', text: queryText(bundle.query) };
  }
  if (!isListOfStrings(bundle.keywords)) {
    throw new RangeError(
      `The keywords of a query bundle are not a list of strings: got ${JSON.stringify(bundle.keywords)}`,
    );
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

/**
 * The texts that an embedding retriever embeds: `customEmbeddings`, or
 * `[query]`. A text of no word has no meaning to embed, so a blank `query`
 * is `wordedNeed`'s `RangeError`, and a blank text of `customEmbeddings` is
 * one in the same words, before the engine reads anything or calls its model.
 */
export const embeddingsOf = (
  query: QueryType,
): readonly [string, ...string[]] => {
  const bundle = bundleOf(query);
  const texts = bundle.customEmbeddings;
  if (texts === undefined) return [wordedNeed(bundle.query)];
  if (!isListOfStrings(texts)) {
    throw new RangeError(
      `The customEmbeddings of a query bundle are not a list of strings: got ${JSON.stringify(texts)}`,
    );
  }
  if (!texts.every((text) => /\S/.test(text))) {
    throw new RangeError(
      `The customEmbeddings of a query bundle hold a text of no word: got ${JSON.stringify(texts)}`,
    );
  }
  return texts;
};
