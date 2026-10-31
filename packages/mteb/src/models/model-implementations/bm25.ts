// mteb/models/model_implementations/bm25.py: MTEB's BM25 baseline
// mteb/baseline-bm25s, for English. Not ported: the other languages of
// _ISO3_TO_LANG, the stopwords from document frequencies (for a language
// without a stopword list), the "char" tokenizer, a tokenizer of
// HuggingFace or a function (and so mteb/baseline-bm25s-subword), and
// options other than k1, b, delta and method.
import type { TaskMetadata } from '../../abstasks/task-metadata.ts';
import { combineQueriesWithInstructionText } from '../../create-dataloaders.ts';
import {
  BM25,
  type Method,
  STOPWORDS_EN,
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

// The bm25s tokenizer with the English stopwords of bm25s and the English
// Snowball stemmer. transform uses the stopwords of the last fit.
export class BM25Tokenizer {
  readonly stopwordsKey = 'en';
  readonly stemmer = new Stemmer('english');
  readonly language: 'eng';
  #combinedList: readonly string[] | null = null;

  constructor(language: 'eng') {
    this.language = language;
  }

  fit(corpusTexts: readonly string[]): this {
    this.fitTransform(corpusTexts);
    return this;
  }

  fitTransform(corpusTexts: readonly string[]): Tokenized {
    this.#combinedList = STOPWORDS_EN;
    return tokenize(corpusTexts, {
      stopwords: this.#combinedList,
      stemmer: this.stemmer,
    });
  }

  transform(texts: readonly string[]): Tokenized {
    return tokenize(texts, {
      stopwords: this.#combinedList,
      stemmer: this.stemmer,
    });
  }
}

export type BM25Kwargs = LoadKwargs & {
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

// BM25 over the bm25s tokens of each document: its title and its text.
export class BM25Search implements SearchProtocol {
  readonly mtebModelMeta: ModelMeta;
  readonly k1: number;
  readonly b: number;
  readonly delta: number;
  readonly method: Method;
  #indexed: Indexed | null = null;

  constructor(options: {
    readonly modelMeta: ModelMeta;
    readonly k1?: number;
    readonly b?: number;
    readonly delta?: number;
    readonly method?: Method;
  }) {
    this.mtebModelMeta = options.modelMeta;
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.delta = options.delta ?? 0.5;
    this.method = options.method ?? 'lucene';
  }

  // A subset with more than one language is read as English, as in MTEB.
  async index(corpus: CorpusDatasetType, options: IndexOptions): Promise<void> {
    const language =
      getLanguage(options.taskMetadata, options.hfSubset) ?? 'eng';
    if (language !== 'eng')
      throw new Error(
        `BM25Search supports English only: the subset '${options.hfSubset}' of the task ${options.taskMetadata.name} has the language '${language}'.`,
      );
    const tokenizer = new BM25Tokenizer(language);
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
  return new BM25Search(options);
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
// lists them. This port runs English only.
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
