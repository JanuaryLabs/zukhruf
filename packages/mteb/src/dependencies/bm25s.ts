import { log } from './libm.ts';
import { mean, sumFloat32 } from './numpy.ts';

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

// The methods of scoring.py. BM25L and BM25+ give each token a score for
// the documents that do not hold it (the non-occurrence score).
export type Method = 'robertson' | 'lucene' | 'atire' | NonoccurrenceMethod;
type NonoccurrenceMethod = 'bm25l' | 'bm25+';

export type BM25Options = {
  readonly k1?: number;
  readonly b?: number;
  // Used by BM25L and BM25+ only.
  readonly delta?: number;
  readonly method?: Method;
};

export type RetrieveResults = {
  readonly documents: number[][];
  readonly scores: Float32Array[];
};

// The idf of a token in df of n documents (_score_idf_*): a float64 that
// the index keeps as a float32. log is the log of the C library, which
// math.log calls.
const IDF: Readonly<Record<Method, (df: number, n: number) => number>> = {
  robertson: (df, n) => {
    const inner = (n - df + 0.5) / (df + 0.5);
    return log(inner < 1 ? 1 : inner);
  },
  lucene: (df, n) => log(1 + (n - df + 0.5) / (df + 0.5)),
  atire: (df, n) => log(n / df),
  bm25l: (df, n) => log((n + 1) / (df + 0.5)),
  'bm25+': (df, n) => log((n + 1) / df),
};

type TfcArguments = {
  readonly tf: number;
  readonly docLen: number;
  readonly avgDocLen: number;
  readonly k1: number;
  readonly b: number;
  readonly delta: number;
};

// The term frequency component of a token with the frequency tf in a
// document (_score_tfc_*), in float64. tf is a float32 array in bm25s, so
// for atire and BM25+, numpy multiplies tf by k1 + 1 in float32.
const TFC: Readonly<Record<Method, (args: TfcArguments) => number>> = {
  robertson: ({ tf, docLen, avgDocLen, k1, b }) =>
    tf / (k1 * (1 - b + (b * docLen) / avgDocLen) + tf),
  lucene: (args) => TFC.robertson(args),
  atire: ({ tf, docLen, avgDocLen, k1, b }) =>
    Math.fround(tf * Math.fround(k1 + 1)) /
    (tf + k1 * (1 - b + (b * docLen) / avgDocLen)),
  bm25l: ({ tf, docLen, avgDocLen, k1, b, delta }) => {
    const c = tf / (1 - b + (b * docLen) / avgDocLen);
    return ((k1 + 1) * (c + delta)) / (k1 + c + delta);
  },
  'bm25+': ({ tf, docLen, avgDocLen, k1, b, delta }) =>
    Math.fround(Math.fround(k1 + 1) * tf) /
      (k1 * (1 - b + (b * docLen) / avgDocLen) + tf) +
    delta,
};

function isNonoccurrenceMethod(method: Method): method is NonoccurrenceMethod {
  return method === 'bm25l' || method === 'bm25+';
}

type Columns = readonly (readonly (readonly [doc: number, score: number])[])[];

// The eager index: for each token id, the float32 score of each document
// that holds it. BM25L and BM25+ also keep the float32 non-occurrence score
// of each token, which retrieve adds back to each document.
type Index = {
  readonly numDocs: number;
  readonly vocab: ReadonlyMap<string, number>;
  readonly columns: Columns;
} & (
  | { readonly method: Exclude<Method, NonoccurrenceMethod> }
  | {
      readonly method: NonoccurrenceMethod;
      readonly nonoccurrence: Float32Array;
    }
);

// The float32 score of each token of each document, by token id.
function scoreColumns(
  corpusIds: readonly (readonly number[])[],
  nVocab: number,
  score: (id: number, tf: number, docLen: number) => number,
): Columns {
  const columns = Array.from(
    { length: nVocab },
    (): (readonly [number, number])[] => [],
  );
  for (const [doc, ids] of corpusIds.entries()) {
    const counts = new Map<number, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, tf] of counts)
      columns[id]?.push([doc, Math.fround(score(id, tf, ids.length))]);
  }
  return columns;
}

export class BM25 {
  readonly k1: number;
  readonly b: number;
  readonly delta: number;
  readonly method: Method;
  #index: Index | null = null;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.delta = options.delta ?? 0.5;
    this.method = options.method ?? 'lucene';
  }

  // index(corpus) for a Tokenized corpus: idf is float32, the term frequency
  // component float64, and each score their float32 product, less the
  // non-occurrence score of the token for BM25L and BM25+.
  index(corpus: Tokenized): void {
    const { k1, b, delta, method } = this;
    const numDocs = corpus.ids.length;
    const avgDocLen = mean(corpus.ids.map((ids) => ids.length));
    const nVocab = corpus.vocab.size;
    const docFrequencies = new Array<number>(nVocab).fill(0);
    for (const ids of corpus.ids)
      for (const id of new Set(ids))
        docFrequencies[id] = (docFrequencies[id] ?? 0) + 1;
    const idf = new Float32Array(
      docFrequencies.map((df) => (df === 0 ? 0 : IDF[method](df, numDocs))),
    );
    const tfc = (tf: number, docLen: number) =>
      TFC[method]({ tf, docLen, avgDocLen, k1, b, delta });
    const base = { numDocs, vocab: corpus.vocab };
    if (!isNonoccurrenceMethod(method)) {
      this.#index = {
        ...base,
        method,
        columns: scoreColumns(
          corpus.ids,
          nVocab,
          (id, tf, docLen) => (idf[id] ?? 0) * tfc(tf, docLen),
        ),
      };
      return;
    }
    // _build_nonoccurrence_array: the float64 idf times the term frequency
    // component of tf 0 in a document of the average length.
    const nonoccurrence = new Float32Array(
      docFrequencies.map((df) =>
        df === 0 ? 0 : IDF[method](df, numDocs) * tfc(0, avgDocLen),
      ),
    );
    this.#index = {
      ...base,
      method,
      nonoccurrence,
      columns: scoreColumns(
        corpus.ids,
        nVocab,
        (id, tf, docLen) =>
          (idf[id] ?? 0) * tfc(tf, docLen) - (nonoccurrence[id] ?? 0),
      ),
    };
  }

  // retrieve(query_tokens, k=k) for Tokenized queries. Each query score adds
  // up the float32 scores of its known tokens in query order. BM25L and BM25+
  // then add to each document the float32 sum (numpy's pairwise sum) of the
  // non-occurrence scores of the known tokens, repeats included. A query
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
      const known = ids.flatMap((id) => {
        const column = index.vocab.get(tokens.get(id) ?? '');
        return column === undefined ? [] : [column];
      });
      for (const column of known)
        for (const [doc, score] of index.columns[column] ?? [])
          queryScores[doc] = (queryScores[doc] ?? 0) + score;
      if (index.method === 'bm25l' || index.method === 'bm25+') {
        const { nonoccurrence } = index;
        const shift = sumFloat32(
          known.map((column) => nonoccurrence[column] ?? 0),
        );
        queryScores.forEach((score, doc) => {
          queryScores[doc] = score + shift;
        });
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
