// mteb/models/model_implementations/bm25.py: MTEB's BM25 baselines
// mteb/baseline-bm25s, with the stopwords, the stemmer and the tokenizer of
// the language of the task, and mteb/baseline-bm25s-subword, with the
// tokenizer of Qwen/Qwen3-0.6B. The tokenizer can also be a function or the
// name of another tokenizer of the HuggingFace Hub.
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
import type { HubOptions } from '../../dependencies/datasets.ts';
import { Stemmer } from '../../dependencies/pystemmer.ts';
import { Tokenizer } from '../../dependencies/tokenizers.ts';
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

// A function from a text to its tokens.
export type CustomTokenizer = (text: string) => string[];

export type BM25TokenizerOptions = {
  readonly stopwordsKey?: StopwordsKey | undefined;
  readonly stemmerLanguage?: string | undefined;
  readonly freqThreshold?: number | undefined;
  readonly tokenizer?: 'char' | CustomTokenizer | undefined;
};

// _unicode_tokenize: the code points of the NFKC form in lower case, without
// U+0020. "\n" and the other spaces stay tokens.
function unicodeTokenize(text: string): string[] {
  return Array.from(text.normalize('NFKC').toLowerCase().replaceAll(' ', ''));
}

// _to_tokenized: an id for each token, in the order of first use.
function toTokenized(tokenLists: readonly (readonly string[])[]): Tokenized {
  const vocab = new Map<string, number>();
  const ids = tokenLists.map((tokens) =>
    tokens.map((token) => {
      const known = vocab.get(token);
      if (known !== undefined) return known;
      vocab.set(token, vocab.size);
      return vocab.size - 1;
    }),
  );
  return { ids, vocab };
}

// The bm25s path splits with the regex of bm25s and stems the words. The
// custom path splits with the char tokenizer or a function, does not stem,
// and does not lowercase (the char tokenizer lowercases itself).
type TokenizerPath =
  | { readonly kind: 'bm25s' }
  | { readonly kind: 'custom'; readonly tokenizer: 'char' | CustomTokenizer };

// The tokenizer of BM25Search: the stopwords, the stemmer and the tokenizer
// of the language, unless the options name them. A language without a
// stopword list gets the stopwords from document frequencies: each token
// (each stem on the bm25s path) in freqThreshold or more of the documents
// of the fit. freqThreshold 0 turns them off. transform uses the stopwords
// of the last fit.
export class BM25Tokenizer {
  readonly stopwordsKey: StopwordsKey | null;
  // MTEB makes the stemmer of a name also on the custom path, which does
  // not use it: an unknown name throws there too.
  readonly stemmer: Stemmer | null;
  readonly freqThreshold: number;
  readonly #path: TokenizerPath;
  // The function of the custom path, from the first fit, as MTEB's
  // _raw_tok, which is None before fit_transform.
  #rawTokenize: CustomTokenizer | null = null;
  #combinedStops: ReadonlySet<string> = new Set();

  // The language null and a code that _ISO3_TO_LANG does not hold get no
  // stopwords, no stemmer and the bm25s tokenizer. A stopwords key or a
  // stemmer name in the options drops the tokenizer of the language, but
  // not the tokenizer of the options.
  constructor(language: string | null, options: BM25TokenizerOptions = {}) {
    const [detectedStopwords, detectedStemmer, detectedTokenizer] =
      (language === null ? undefined : ISO3_TO_LANG.get(language)) ??
      NO_LANGUAGE;
    this.stopwordsKey = options.stopwordsKey ?? detectedStopwords;
    const stemmerLanguage = options.stemmerLanguage ?? detectedStemmer;
    const tokenizer =
      options.stopwordsKey !== undefined ||
      options.stemmerLanguage !== undefined
        ? (options.tokenizer ?? null)
        : (options.tokenizer ?? detectedTokenizer);
    this.#path =
      tokenizer === null ? { kind: 'bm25s' } : { kind: 'custom', tokenizer };
    this.freqThreshold = options.freqThreshold ?? 0.9;
    // A stemmer name of "" gives no stemmer, as in MTEB (if stemmer_lang).
    this.stemmer = stemmerLanguage ? new Stemmer(stemmerLanguage) : null;
  }

  fit(corpusTexts: readonly string[]): this {
    this.fitTransform(corpusTexts);
    return this;
  }

  fitTransform(corpusTexts: readonly string[]): Tokenized {
    const path = this.#path;
    if (path.kind === 'bm25s') return this.#fitTransformBm25s(corpusTexts);
    this.#rawTokenize =
      path.tokenizer === 'char' ? unicodeTokenize : path.tokenizer;
    return this.#fitTransformCustom(corpusTexts, this.#rawTokenize);
  }

  // The stopwords from document frequencies are stems, and bm25s removes
  // stopwords before it stems the words. Thus a query loses a word that
  // equals a frequent stem, and keeps an inflected form of it, as in MTEB.
  // Before a fit, the custom path throws for each text, as MTEB calls None.
  transform(texts: readonly string[]): Tokenized {
    if (this.#path.kind === 'bm25s')
      return tokenize(texts, {
        stopwords: [...this.#combinedStops],
        stemmer: this.stemmer,
      });
    return toTokenized(
      texts.map((text) => {
        if (this.#rawTokenize === null)
          throw new TypeError("'NoneType' object is not callable");
        return this.#rawTokenize(text).filter(
          (token) => !this.#combinedStops.has(token),
        );
      }),
    );
  }

  #fitTransformBm25s(corpusTexts: readonly string[]): Tokenized {
    if (this.stopwordsKey !== null || this.freqThreshold === 0) {
      this.#combinedStops = new Set(
        this.stopwordsKey === null ? [] : STOPWORDS[this.stopwordsKey],
      );
      return tokenize(corpusTexts, {
        stopwords: [...this.#combinedStops],
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
    this.#combinedStops = new Set(
      Array.from(raw.vocab)
        .filter(([, id]) => stopIds.has(id))
        .map(([token]) => token),
    );
    // The stems stay in the vocabulary without documents, so bm25s gives
    // them an idf of 0.
    return {
      ids: raw.ids.map((ids) => ids.filter((id) => !stopIds.has(id))),
      vocab: raw.vocab,
    };
  }

  // The stopwords of the custom path are the named stopwords and, without
  // a stopwords key, the tokens from document frequencies.
  #fitTransformCustom(
    corpusTexts: readonly string[],
    tokenizeText: CustomTokenizer,
  ): Tokenized {
    const rawTokenLists = corpusTexts.map((text) => tokenizeText(text));
    const freqStops: string[] = [];
    if (this.stopwordsKey === null && this.freqThreshold > 0) {
      const docFrequencies = new Map<string, number>();
      for (const tokens of rawTokenLists)
        for (const token of new Set(tokens))
          docFrequencies.set(token, (docFrequencies.get(token) ?? 0) + 1);
      for (const [token, df] of docFrequencies)
        if (df / corpusTexts.length >= this.freqThreshold)
          freqStops.push(token);
    }
    const namedStops =
      this.stopwordsKey === null ? [] : STOPWORDS[this.stopwordsKey];
    this.#combinedStops = new Set([...namedStops, ...freqStops]);
    return toTokenized(
      rawTokenLists.map((tokens) =>
        tokens.filter((token) => !this.#combinedStops.has(token)),
      ),
    );
  }
}

// The keyword arguments of loadModel keep MTEB's snake_case names, because
// they name the experiment: freq_threshold 0 gives "freq_threshold_0".
export type BM25Kwargs = LoadKwargs & {
  readonly stopwords?: StopwordsKey;
  readonly stemmer_language?: string;
  readonly freq_threshold?: number;
  readonly tokenizer?: string | CustomTokenizer;
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
  readonly #tokenizer: string | CustomTokenizer | undefined;
  readonly #hub: HubOptions;
  #indexed: Indexed | null = null;

  // stopwords and stemmerLanguage replace those of the language of the task.
  // A tokenizer drops the language: the documents get no stemmer, and the
  // stopwords from document frequencies unless stopwords names a list. A
  // string as the tokenizer names a tokenizer.json of the HuggingFace Hub,
  // which hub reads.
  constructor(options: {
    readonly modelMeta: ModelMeta;
    readonly stopwords?: StopwordsKey | undefined;
    readonly stemmerLanguage?: string | undefined;
    readonly freqThreshold?: number | undefined;
    readonly tokenizer?: string | CustomTokenizer | undefined;
    readonly hub?: HubOptions;
    readonly k1?: number;
    readonly b?: number;
    readonly delta?: number;
    readonly method?: Method;
  }) {
    this.mtebModelMeta = options.modelMeta;
    this.#stopwords = options.stopwords;
    this.#stemmerLanguage = options.stemmerLanguage;
    this.#freqThreshold = options.freqThreshold ?? 0.9;
    this.#tokenizer = options.tokenizer;
    this.#hub = options.hub ?? {};
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.delta = options.delta ?? 0.5;
    this.method = options.method ?? 'lucene';
  }

  // MTEB's _resolve_tokenizer: the tokens of a Hub tokenizer without " "
  // and "▁", and without a token of only those characters. MTEB reads the
  // tokenizer once, when it makes the model; here each index reads it.
  async #resolveTokenizer(): Promise<CustomTokenizer | undefined> {
    const tokenizer = this.#tokenizer;
    if (typeof tokenizer !== 'string') return tokenizer;
    const hfTokenizer = await Tokenizer.fromPretrained(tokenizer, this.#hub);
    return (text) =>
      hfTokenizer
        .encode(text, { addSpecialTokens: false })
        .tokens.map((token) => token.replaceAll(' ', '').replaceAll('▁', ''))
        .filter((token) => token !== '');
  }

  // A subset with more than one language is read as English, as in MTEB.
  async index(corpus: CorpusDatasetType, options: IndexOptions): Promise<void> {
    const customTokenizer = await this.#resolveTokenizer();
    const tokenizer = new BM25Tokenizer(
      customTokenizer === undefined
        ? (getLanguage(options.taskMetadata, options.hfSubset) ?? 'eng')
        : null,
      {
        stopwordsKey: this.#stopwords,
        stemmerLanguage: this.#stemmerLanguage,
        freqThreshold: this.#freqThreshold,
        tokenizer: customTokenizer,
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

// The languages of the tokenizer of Qwen3, as MTEB lists them.
const QWEN_LANGUAGES = [
  'afr-Latn',
  'ara-Arab',
  'aze-Latn',
  'bel-Cyrl',
  'bul-Cyrl',
  'ben-Beng',
  'cat-Latn',
  'ceb-Latn',
  'ces-Latn',
  'cym-Latn',
  'dan-Latn',
  'deu-Latn',
  'ell-Grek',
  'eng-Latn',
  'spa-Latn',
  'est-Latn',
  'eus-Latn',
  'fas-Arab',
  'fin-Latn',
  'fra-Latn',
  'glg-Latn',
  'guj-Gujr',
  'heb-Hebr',
  'hin-Deva',
  'hrv-Latn',
  'hat-Latn',
  'hun-Latn',
  'hye-Armn',
  'ind-Latn',
  'isl-Latn',
  'ita-Latn',
  'jpn-Jpan',
  'jav-Latn',
  'kat-Geor',
  'kaz-Cyrl',
  'khm-Khmr',
  'kan-Knda',
  'kor-Hang',
  'kir-Cyrl',
  'lao-Laoo',
  'lit-Latn',
  'lav-Latn',
  'mkd-Cyrl',
  'mal-Mlym',
  'mon-Cyrl',
  'mar-Deva',
  'msa-Latn',
  'mya-Mymr',
  'nep-Deva',
  'nld-Latn',
  'nor-Latn',
  'nob-Latn',
  'nno-Latn',
  'pan-Guru',
  'pol-Latn',
  'por-Latn',
  'que-Latn',
  'ron-Latn',
  'rus-Cyrl',
  'sin-Sinh',
  'slk-Latn',
  'slv-Latn',
  'swa-Latn',
  'tam-Taml',
  'tel-Telu',
  'tha-Thai',
  'tgl-Latn',
  'tur-Latn',
  'ukr-Cyrl',
  'urd-Arab',
  'vie-Latn',
  'yor-Latn',
  'zho-Hans',
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

export const bm25SSubword = new ModelMeta<BM25Kwargs, BM25Search>({
  loader: bm25Loader,
  loaderKwargs: { tokenizer: 'Qwen/Qwen3-0.6B' },
  extraRequirementsGroups: ['bm25s'],
  name: 'mteb/baseline-bm25s-subword',
  modelType: ['sparse'],
  languages: QWEN_LANGUAGES,
  openWeights: true,
  revision: '0_1_0',
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
