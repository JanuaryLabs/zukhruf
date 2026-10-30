import { mean } from './numpy.ts';

// bm25s 0.3.16: tokenize (tokenization.py), the Lucene variant of BM25
// (scoring.py) and the numpy path of BM25.index and BM25.retrieve
// (__init__.py, selection.py). Only what MTEB's mteb/baseline-bm25s calls is
// ported: token ids are never passed in, there is no corpus to return, no
// weight mask, no numba or jax backend, and no save or load.

// STOPWORDS_EN of stopwords.py.
export const STOPWORDS_EN: readonly string[] = [
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'such',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
];

// The token ids of each text and the id of each token (or stem).
export type Tokenized = {
  readonly ids: readonly (readonly number[])[];
  readonly vocab: ReadonlyMap<string, number>;
};

export type WordStemmer = {
  stemWords(words: Iterable<string>): string[];
};

// Python's (?u)\b\w\w+\b: runs of two or more letters, digits or "_".
const TOKEN_PATTERN = /[\p{L}\p{N}_]{2,}/gu;

// tokenize(texts, stopwords=..., stemmer=...) with lower=True and
// return_ids=True. The stopwords leave before the stemmer runs.
export function tokenize(
  texts: readonly string[],
  options: {
    readonly stopwords?: readonly string[] | null;
    readonly stemmer?: WordStemmer | null;
  } = {},
): Tokenized {
  const stopwords = new Set(
    options.stopwords === undefined ? STOPWORDS_EN : (options.stopwords ?? []),
  );
  const tokenToIndex = new Map<string, number>();
  const corpusIds = texts.map((text) =>
    Array.from(text.toLowerCase().match(TOKEN_PATTERN) ?? [])
      .filter((token) => !stopwords.has(token))
      .map((token) => {
        const known = tokenToIndex.get(token);
        if (known !== undefined) return known;
        tokenToIndex.set(token, tokenToIndex.size);
        return tokenToIndex.size - 1;
      }),
  );
  const stemmer = options.stemmer ?? null;
  if (stemmer === null) return { ids: corpusIds, vocab: tokenToIndex };
  const stems = stemmer.stemWords(tokenToIndex.keys());
  const vocab = new Map([...new Set(stems)].map((stem, id) => [stem, id]));
  const stemIds = stems.map((stem) => vocab.get(stem) ?? -1);
  return {
    ids: corpusIds.map((ids) => ids.map((id) => stemIds[id] ?? -1)),
    vocab,
  };
}

export type BM25Options = {
  readonly k1?: number;
  readonly b?: number;
  // Used by BM25L and BM25+ only.
  readonly delta?: number;
  readonly method?: 'lucene';
};

export type RetrieveResults = {
  readonly documents: number[][];
  readonly scores: Float32Array[];
};

// The eager index: for each token id, the float32 score of each document
// that holds it.
type Index = {
  readonly numDocs: number;
  readonly vocab: ReadonlyMap<string, number>;
  readonly columns: readonly (readonly (readonly [
    doc: number,
    score: number,
  ])[])[];
};

export class BM25 {
  readonly k1: number;
  readonly b: number;
  readonly delta: number;
  readonly method: 'lucene';
  #index: Index | null = null;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.delta = options.delta ?? 0.5;
    this.method = options.method ?? 'lucene';
  }

  // index(corpus) for a Tokenized corpus: idf is float32, the term frequency
  // component float64, and each score their float32 product.
  index(corpus: Tokenized): void {
    const numDocs = corpus.ids.length;
    const avgDocLen = mean(corpus.ids.map((ids) => ids.length));
    const nVocab = corpus.vocab.size;
    const docFrequencies = new Array<number>(nVocab).fill(0);
    for (const ids of corpus.ids)
      for (const id of new Set(ids))
        docFrequencies[id] = (docFrequencies[id] ?? 0) + 1;
    const idf = new Float32Array(
      docFrequencies.map((df) =>
        df === 0 ? 0 : Math.log(1 + (numDocs - df + 0.5) / (df + 0.5)),
      ),
    );
    const columns = Array.from(
      { length: nVocab },
      (): (readonly [number, number])[] => [],
    );
    for (const [doc, ids] of corpus.ids.entries()) {
      const counts = new Map<number, number>();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, tf] of counts) {
        const tfc =
          tf /
          (this.k1 * (1 - this.b + (this.b * ids.length) / avgDocLen) + tf);
        columns[id]?.push([doc, Math.fround((idf[id] ?? 0) * tfc)]);
      }
    }
    this.#index = { numDocs, vocab: corpus.vocab, columns };
  }

  // retrieve(query_tokens, k=k) for Tokenized queries. Each query score adds
  // up the float32 scores of its known tokens in query order; a query
  // without a known token scores 0 for each document. Equal scores keep the
  // lower document first; numpy's argpartition has no fixed order for them.
  retrieve(
    queries: Tokenized,
    options: { readonly k?: number } = {},
  ): RetrieveResults {
    const index = this.#index;
    if (index === null)
      throw new Error('The index is empty. Call `index` first.');
    const k = options.k ?? 10;
    if (k > index.numDocs)
      throw new Error(
        `k of ${k} is larger than the number of available scores, which is ${index.numDocs} (corpus size should be larger than top-k). Please set with a smaller k or increase the size of corpus.`,
      );
    const tokens = new Map(
      [...queries.vocab].map(([token, id]) => [id, token]),
    );
    const documents: number[][] = [];
    const scores: Float32Array[] = [];
    for (const ids of queries.ids) {
      const queryScores = new Float32Array(index.numDocs);
      for (const id of ids) {
        const column = index.vocab.get(tokens.get(id) ?? '');
        if (column === undefined) continue;
        for (const [doc, score] of index.columns[column] ?? [])
          queryScores[doc] = (queryScores[doc] ?? 0) + score;
      }
      const top = Array.from(queryScores, (_, doc) => doc)
        .sort(
          (left, right) =>
            (queryScores[right] ?? 0) - (queryScores[left] ?? 0) ||
            left - right,
        )
        .slice(0, k);
      documents.push(top);
      scores.push(Float32Array.from(top, (doc) => queryScores[doc] ?? 0));
    }
    return { documents, scores };
  }
}
