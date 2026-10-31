// mteb/models/model_implementations/bm25.py: MTEB's BM25 baseline
// mteb/baseline-bm25s, with the stopwords and the stemmer of the language of
// the task. Not ported yet: the "char" tokenizer, a tokenizer of HuggingFace
// or a function (and so mteb/baseline-bm25s-subword).
import type { TaskMetadata } from '../../abstasks/task-metadata.ts';
import { combineQueriesWithInstructionText } from '../../create-dataloaders.ts';
import {
  STOPWORDS_CHINESE,
  STOPWORDS_DUTCH,
  STOPWORDS_EN,
  STOPWORDS_FRENCH,
  STOPWORDS_GERMAN,
  STOPWORDS_ITALIAN,
  STOPWORDS_NORWEGIAN,
  STOPWORDS_PORTUGUESE,
  STOPWORDS_RUSSIAN,
  STOPWORDS_SPANISH,
  STOPWORDS_SWEDISH,
} from '../../dependencies/bm25s-stopwords.ts';
import {
  BM25,
  type Method,
  type Tokenized,
  tokenize,
} from '../../dependencies/bm25s.ts';
import { Stemmer } from '../../dependencies/pystemmer.ts';
import type {
  CorpusDatasetType,
  QueryDatasetType,
  RetrievalOutputType,
} from '../../types/encoder-io.ts';
import type { ISOLanguageScript } from '../../types/metadata.ts';
import {
  type LoadKwargs,
  type LoaderOptions,
  ModelMeta,
} from '../model-meta.ts';
import type {
  IndexOptions,
  SearchOptions,
  SearchProtocol,
} from '../models-protocols.ts';

// The bm25s stopword lists of _get_stopwords, by key. A key that the map
// does not hold raises KeyError in MTEB; the type rejects it here.
const STOPWORDS = {
  en: STOPWORDS_EN,
  de: STOPWORDS_GERMAN,
  nl: STOPWORDS_DUTCH,
  fr: STOPWORDS_FRENCH,
  es: STOPWORDS_SPANISH,
  pt: STOPWORDS_PORTUGUESE,
  it: STOPWORDS_ITALIAN,
  ru: STOPWORDS_RUSSIAN,
  sv: STOPWORDS_SWEDISH,
  no: STOPWORDS_NORWEGIAN,
  zh: STOPWORDS_CHINESE,
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type StopwordsKey = keyof typeof STOPWORDS;

type LanguageSettings = readonly [
  stopwordsKey: StopwordsKey | null,
  stemmerLanguage: string | null,
  tokenizer: 'char' | null,
];

// _ISO3_TO_LANG: the stopwords key, the PyStemmer name and the tokenizer of
// each ISO 639-3 code.
const ISO3_TO_LANG: ReadonlyMap<string, LanguageSettings> = new Map([
  ['eng', ['en', 'english', null]],
  ['deu', ['de', 'german', null]],
  ['nld', ['nl', 'dutch', null]],
  ['fra', ['fr', 'french', null]],
  ['spa', ['es', 'spanish', null]],
  ['por', ['pt', 'portuguese', null]],
  ['ita', ['it', 'italian', null]],
  ['rus', ['ru', 'russian', null]],
  ['swe', ['sv', 'swedish', null]],
  ['nob', ['no', 'norwegian', null]],
  ['nno', ['no', 'norwegian', null]],
  ['nor', ['no', 'norwegian', null]],
  ['zho', ['zh', null, 'char']],
  ['cmn', ['zh', null, 'char']],
  ['jpn', [null, null, 'char']],
  ['kor', [null, null, 'char']],
  ['tha', [null, null, 'char']],
  ['khm', [null, null, 'char']],
  ['mya', [null, null, 'char']],
  ['bod', [null, null, 'char']],
  ['lao', [null, null, 'char']],
  ['ara', [null, 'arabic', null]],
  ['arb', [null, 'arabic', null]],
  ['hye', [null, 'armenian', null]],
  ['eus', [null, 'basque', null]],
  ['cat', [null, 'catalan', null]],
  ['dan', [null, 'danish', null]],
  ['epo', [null, 'esperanto', null]],
  ['est', [null, 'estonian', null]],
  ['fin', [null, 'finnish', null]],
  ['ell', [null, 'greek', null]],
  ['hin', [null, 'hindi', null]],
  ['hun', [null, 'hungarian', null]],
  ['ind', [null, 'indonesian', null]],
  ['gle', [null, 'irish', null]],
  ['lit', [null, 'lithuanian', null]],
  ['nep', [null, 'nepali', null]],
  ['ron', [null, 'romanian', null]],
  ['srp', [null, 'serbian', null]],
  ['tam', [null, 'tamil', null]],
  ['tur', [null, 'turkish', null]],
  ['yid', [null, 'yiddish', null]],
]);

// What MTEB's _ISO3_TO_LANG.get gives a code that the table does not hold,
// and the language null.
const NO_LANGUAGE: LanguageSettings = [null, null, null];

// The ISO 639-3 code of the subset, or null when the subset has more than
// one language.
export function getLanguage(
  taskMetadata: TaskMetadata,
  hfSubset: string,
): string | null {
  const { evalLangs } = taskMetadata;
  const languages: readonly ISOLanguageScript[] = Array.isArray(evalLangs)
    ? evalLangs
    : (evalLangs.get(hfSubset) ?? []);
  const codes = new Set(languages.map((language) => language.split('-')[0]));
  if (codes.size !== 1) return null;
  return [...codes][0] ?? null;
}

export type BM25TokenizerOptions = {
  readonly stopwordsKey?: StopwordsKey | undefined;
  readonly stemmerLanguage?: string | undefined;
  readonly freqThreshold?: number | undefined;
};

// The tokenizer of the bm25s path: the stopwords and the stemmer of the
// language, unless the options name them. A language without a stopword
// list gets the stopwords from document frequencies: each stem (each word
// without a stemmer) in freqThreshold or more of the documents of the fit.
// freqThreshold 0 turns them off. transform uses the stopwords of the last
// fit.
export class BM25Tokenizer {
  readonly stopwordsKey: StopwordsKey | null;
  readonly stemmer: Stemmer | null;
  readonly freqThreshold: number;
  readonly #tokenizer: 'char' | null;
  #combinedList: readonly string[] | null = null;

  // The language null and a code that _ISO3_TO_LANG does not hold get no
  // stopwords, no stemmer and the bm25s tokenizer. A stopwords key or a
  // stemmer name in the options drops the tokenizer of the language.
  constructor(language: string | null, options: BM25TokenizerOptions = {}) {
    const [detectedStopwords, detectedStemmer, detectedTokenizer] =
      (language === null ? undefined : ISO3_TO_LANG.get(language)) ??
      NO_LANGUAGE;
    this.stopwordsKey = options.stopwordsKey ?? detectedStopwords;
    const stemmerLanguage = options.stemmerLanguage ?? detectedStemmer;
    this.#tokenizer =
      options.stopwordsKey !== undefined ||
      options.stemmerLanguage !== undefined
        ? null
        : detectedTokenizer;
    this.freqThreshold = options.freqThreshold ?? 0.9;
    // A stemmer name of "" gives no stemmer, as in MTEB (if stemmer_lang).
    this.stemmer = stemmerLanguage ? new Stemmer(stemmerLanguage) : null;
  }

  fit(corpusTexts: readonly string[]): this {
    this.fitTransform(corpusTexts);
    return this;
  }

  fitTransform(corpusTexts: readonly string[]): Tokenized {
    if (this.#tokenizer !== null)
      throw new Error(
        `BM25Tokenizer does not port the tokenizer '${this.#tokenizer}' yet.`,
      );
    if (this.stopwordsKey !== null || this.freqThreshold === 0) {
      this.#combinedList =
        this.stopwordsKey === null ? null : STOPWORDS[this.stopwordsKey];
      return tokenize(corpusTexts, {
        stopwords: this.#combinedList,
        stemmer: this.stemmer,
      });
    }
    const raw = tokenize(corpusTexts, {
      stopwords: null,
      stemmer: this.stemmer,
    });
    const docFrequencies = new Map<number, number>();
    for (const ids of raw.ids)
      for (const id of new Set(ids))
        docFrequencies.set(id, (docFrequencies.get(id) ?? 0) + 1);
    const stopIds = new Set(
      Array.from(docFrequencies)
        .filter(([, df]) => df / corpusTexts.length >= this.freqThreshold)
        .map(([id]) => id),
    );
    const freqStops = Array.from(raw.vocab)
      .filter(([, id]) => stopIds.has(id))
      .map(([token]) => token);
    this.#combinedList = freqStops.length > 0 ? freqStops : null;
    // The stems stay in the vocabulary without documents, so bm25s gives
    // them an idf of 0.
    return {
      ids: raw.ids.map((ids) => ids.filter((id) => !stopIds.has(id))),
      vocab: raw.vocab,
    };
  }

  // The stopwords from document frequencies are stems, and bm25s removes
  // stopwords before it stems the words. Thus a query loses a word that
  // equals a frequent stem, and keeps an inflected form of it, as in MTEB.
  transform(texts: readonly string[]): Tokenized {
    return tokenize(texts, {
      stopwords: this.#combinedList,
      stemmer: this.stemmer,
    });
  }
}

// The keyword arguments of loadModel keep MTEB's snake_case names, because
// they name the experiment: freq_threshold 0 gives "freq_threshold_0".
export type BM25Kwargs = LoadKwargs & {
  readonly stopwords?: StopwordsKey;
  readonly stemmer_language?: string;
  readonly freq_threshold?: number;
  readonly k1?: number;
  readonly b?: number;
  readonly delta?: number;
  readonly method?: Method;
  readonly model?: never;
};

type Indexed = {
  readonly tokenizer: BM25Tokenizer;
  readonly retriever: BM25;
  readonly corpusIds: readonly string[];
};

// BM25 over the tokens of each document: its title and its text.
export class BM25Search implements SearchProtocol {
  readonly mtebModelMeta: ModelMeta;
  readonly k1: number;
  readonly b: number;
  readonly delta: number;
  readonly method: Method;
  readonly #stopwords: StopwordsKey | undefined;
  readonly #stemmerLanguage: string | undefined;
  readonly #freqThreshold: number;
  #indexed: Indexed | null = null;

  // stopwords and stemmerLanguage replace those of the language of the task.
  constructor(options: {
    readonly modelMeta: ModelMeta;
    readonly stopwords?: StopwordsKey | undefined;
    readonly stemmerLanguage?: string | undefined;
    readonly freqThreshold?: number | undefined;
    readonly k1?: number;
    readonly b?: number;
    readonly delta?: number;
    readonly method?: Method;
  }) {
    this.mtebModelMeta = options.modelMeta;
    this.#stopwords = options.stopwords;
    this.#stemmerLanguage = options.stemmerLanguage;
    this.#freqThreshold = options.freqThreshold ?? 0.9;
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.delta = options.delta ?? 0.5;
    this.method = options.method ?? 'lucene';
  }

  // A subset with more than one language is read as English, as in MTEB.
  async index(corpus: CorpusDatasetType, options: IndexOptions): Promise<void> {
    const tokenizer = new BM25Tokenizer(
      getLanguage(options.taskMetadata, options.hfSubset) ?? 'eng',
      {
        stopwordsKey: this.#stopwords,
        stemmerLanguage: this.#stemmerLanguage,
        freqThreshold: this.#freqThreshold,
      },
    );
    const encodedCorpus = tokenizer.fitTransform(
      corpus.map((doc) => `${doc.title ?? ''}\n${doc.text}`),
    );
    const retriever = new BM25({
      k1: this.k1,
      b: this.b,
      delta: this.delta,
      method: this.method,
    });
    retriever.index(encodedCorpus);
    this.#indexed = {
      tokenizer,
      retriever,
      corpusIds: corpus.map((doc) => doc.id),
    };
  }

  // The float32 score of each of the topK best documents of each query. A
  // reranking keeps the candidates of a query among the topK of the whole
  // corpus.
  async search(
    queries: QueryDatasetType,
    options: SearchOptions,
  ): Promise<RetrievalOutputType> {
    const indexed = this.#indexed;
    if (indexed === null)
      throw new Error('Tokenizer not initialized. Call `index` first.');
    const results: RetrievalOutputType = new Map(
      queries.map((query) => [query.id, new Map<string, number>()]),
    );
    const textQueries = queries.map((query) => {
      const { text } = query;
      if (typeof text !== 'string')
        throw new TypeError(
          `BM25Search searches with text: the query ${query.id} is a conversation.`,
        );
      return { ...query, text };
    });
    const queryTokens = indexed.tokenizer.transform(
      combineQueriesWithInstructionText(textQueries).map((query) => query.text),
    );
    const { documents, scores } = indexed.retriever.retrieve(queryTokens, {
      k: Math.min(options.topK, indexed.corpusIds.length),
    });
    for (const [index, query] of queries.entries()) {
      const queryDocuments = options.topRanked?.get(query.id) ?? null;
      const docIdToScore = new Map<string, number>();
      for (const [rank, doc] of (documents[index] ?? []).entries()) {
        const docId = indexed.corpusIds[doc] ?? '';
        if (queryDocuments !== null && !queryDocuments.includes(docId))
          continue;
        docIdToScore.set(docId, scores[index]?.[rank] ?? 0);
      }
      results.set(query.id, docIdToScore);
    }
    return results;
  }
}

export function bm25Loader(
  _name: string,
  _revision: string | null,
  options: LoaderOptions<BM25Kwargs>,
): BM25Search {
  const { stemmer_language, freq_threshold, ...rest } = options;
  return new BM25Search({
    ...rest,
    stemmerLanguage: stemmer_language,
    freqThreshold: freq_threshold,
  });
}
// model_meta.json names a loader by MTEB's __name__, and MTEB finds the loader
// in its registry by that name.
Object.defineProperty(bm25Loader, 'name', { value: 'bm25_loader' });

const BM25_CITATION = `@misc{bm25s,
      title={BM25S: Orders of magnitude faster lexical search via eager sparse scoring},
      author={Xing Han Lù},
      year={2024},
      eprint={2407.03618},
      archivePrefix={arXiv},
      primaryClass={cs.IR},
      url={https://arxiv.org/abs/2407.03618},
}`;

// The languages that bm25s has a stopword list or a tokenizer for, as MTEB
// lists them.
const BM25_S_LANGUAGES = [
  'eng-Latn',
  'deu-Latn',
  'nld-Latn',
  'fra-Latn',
  'spa-Latn',
  'por-Latn',
  'ita-Latn',
  'swe-Latn',
  'nob-Latn',
  'nno-Latn',
  'nor-Latn',
  'zho-Hans',
  'zho-Hant',
  'cmn-Hans',
  'cmn-Hant',
];

export const bm25S = new ModelMeta<BM25Kwargs, BM25Search>({
  loader: bm25Loader,
  extraRequirementsGroups: ['bm25s'],
  name: 'mteb/baseline-bm25s',
  modelType: ['sparse'],
  languages: BM25_S_LANGUAGES,
  openWeights: true,
  revision: '0_3_0',
  releaseDate: '2026-05-06',
  nParameters: 0,
  nEmbeddingParameters: 0,
  memoryUsageMb: null,
  embedDim: null,
  license: null,
  maxTokens: null,
  reference: 'https://github.com/xhluca/bm25s',
  similarityFnName: null,
  framework: [],
  useInstructions: false,
  publicTrainingCode: 'https://github.com/xhluca/bm25s',
  publicTrainingData: null,
  trainingDatasets: null,
  citation: BM25_CITATION,
});
