import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AbsTaskRetrieval } from '../../abstasks/retrieval.ts';
import { TaskMetadata } from '../../abstasks/task-metadata.ts';
import type { Tokenized } from '../../dependencies/bm25s.ts';
import { evaluate } from '../../evaluate.ts';
import type { ISOLanguageScript } from '../../types/metadata.ts';
import {
  type BM25Kwargs,
  BM25Search,
  BM25Tokenizer,
  type StopwordsKey,
  bm25S,
} from './bm25.ts';

// fixtures/bm25/ is a folder dataset and what Python MTEB 2.26.28 with bm25s
// 0.3.16 and PyStemmer 3.1.0 gave for it: the float32 score of each document
// for each query, a reranking, and the stem of each word. generate.py makes
// both.
const FOLDER = join(import.meta.dirname, 'fixtures/bm25');

// fixtures/bm25-methods/ is a second folder dataset and what MTEB gave for
// it and for the folder of fixtures/bm25/ with each bm25s method, with the
// default settings and with k1 1.2, b 0.5 and delta 0.3: the scores and the
// main score of mteb.evaluate. Its generate.py makes both.
const METHODS_FOLDER = join(import.meta.dirname, 'fixtures/bm25-methods');

// fixtures/bm25-languages/ holds a folder dataset for each of deu, fin, pol,
// rus, zho, jpn and tha, and what MTEB gave for each run of a folder with
// its language and keyword arguments: the experiment name, the scores and
// the main score of mteb.evaluate. It holds the scores of BM25Search with
// the function text.split(" ") as the tokenizer, and the error of MTEB for
// that function through load_model. It also holds the stopwords key, the
// stems of a probe list and the tokens of a probe corpus that BM25Tokenizer
// gives each language of MTEB's table. Its generate.py makes it.
const LANGUAGES_FOLDER = join(import.meta.dirname, 'fixtures/bm25-languages');

type Expected = {
  readonly top_ranked: Readonly<Record<string, readonly string[]>>;
  readonly full: [string, [string, number][]][];
  readonly rerank: [string, [string, number][]][];
  readonly stems: [string, string][];
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

type MethodRun = {
  readonly folder: 'methods' | 'bm25';
  readonly kwargs: BM25Kwargs;
  readonly full: [string, [string, number][]][];
  readonly main_score: number;
};

const methodRuns: readonly MethodRun[] = JSON.parse(
  readFileSync(join(METHODS_FOLDER, 'expected.json'), 'utf8'),
).runs;

type LanguageFolder = 'deu' | 'fin' | 'pol' | 'rus' | 'zho' | 'jpn' | 'tha';

type LanguageRun = {
  readonly folder: LanguageFolder;
  readonly kwargs: BM25Kwargs;
  readonly experiment_name: string | null;
  readonly model_name_with_experiment: string;
  readonly full: [string, [string, number][]][];
  readonly main_score: number;
};

type FunctionRun = {
  readonly folder: LanguageFolder;
  readonly kwargs: {
    readonly stopwords?: StopwordsKey;
    readonly freq_threshold?: number;
  };
  readonly full: [string, [string, number][]][];
};

const languagesExpected: {
  readonly probe: readonly string[];
  readonly probe_corpus: readonly string[];
  readonly probe_queries: readonly string[];
  readonly load_model_error: string;
  readonly languages: readonly {
    readonly language: string;
    readonly stopwords_key: string | null;
    readonly stems: readonly string[] | null;
    readonly tokens: readonly (readonly string[])[];
    readonly query_tokens: readonly (readonly string[])[];
  }[];
  readonly runs: readonly LanguageRun[];
  readonly function_runs: readonly FunctionRun[];
} = JSON.parse(readFileSync(join(LANGUAGES_FOLDER, 'expected.json'), 'utf8'));

const FOLDERS = {
  bm25: { name: 'Bm25Fixture', path: FOLDER },
  methods: { name: 'Bm25MethodsFixture', path: METHODS_FOLDER },
} as const;

const LANGUAGE_FOLDERS: Readonly<
  Record<
    LanguageFolder,
    {
      readonly name: string;
      readonly path: string;
      readonly evalLangs: ISOLanguageScript[];
    }
  >
> = {
  deu: {
    name: 'Bm25LanguagesDeuFixture',
    path: join(LANGUAGES_FOLDER, 'deu'),
    evalLangs: ['deu-Latn'],
  },
  fin: {
    name: 'Bm25LanguagesFinFixture',
    path: join(LANGUAGES_FOLDER, 'fin'),
    evalLangs: ['fin-Latn'],
  },
  pol: {
    name: 'Bm25LanguagesPolFixture',
    path: join(LANGUAGES_FOLDER, 'pol'),
    evalLangs: ['pol-Latn'],
  },
  rus: {
    name: 'Bm25LanguagesRusFixture',
    path: join(LANGUAGES_FOLDER, 'rus'),
    evalLangs: ['rus-Cyrl'],
  },
  zho: {
    name: 'Bm25LanguagesZhoFixture',
    path: join(LANGUAGES_FOLDER, 'zho'),
    evalLangs: ['zho-Hans'],
  },
  jpn: {
    name: 'Bm25LanguagesJpnFixture',
    path: join(LANGUAGES_FOLDER, 'jpn'),
    evalLangs: ['jpn-Jpan'],
  },
  tha: {
    name: 'Bm25LanguagesThaFixture',
    path: join(LANGUAGES_FOLDER, 'tha'),
    evalLangs: ['tha-Thai'],
  },
};

class FolderTask extends AbsTaskRetrieval {
  constructor(
    evalLangs: ISOLanguageScript[] = ['eng-Latn'],
    folder: { readonly name: string; readonly path: string } = FOLDERS.bm25,
  ) {
    super({
      metadata: new TaskMetadata({
        name: folder.name,
        description: 'The BM25 fixture of @zukhruf/mteb.',
        dataset: { path: folder.path, revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs,
        mainScore: 'ndcg_at_10',
      }),
    });
  }
}

async function searchFolder(
  task: FolderTask,
  topRanked: ReadonlyMap<string, readonly string[]> | null,
  kwargs: BM25Kwargs = {},
) {
  await task.loadData();
  const split = task.dataset?.get('default')?.get('test');
  assert.ok(split);
  const location = {
    taskMetadata: task.metadata,
    hfSplit: 'test',
    hfSubset: 'default',
    encodeKwargs: {},
  };
  const model = bm25S.loadModel(kwargs);
  await model.index(split.corpus, location);
  return model.search(split.queries, { ...location, topK: 100, topRanked });
}

function asMaps(
  results: readonly [string, [string, number][]][],
): Map<string, Map<string, number>> {
  return new Map(results.map(([query, docs]) => [query, new Map(docs)]));
}

test('each document of each query has the float32 score that MTEB gives, to the last bit', async () => {
  const results = await searchFolder(new FolderTask(), null);

  assert.deepEqual(results, asMaps(expected.full));
});

test('a reranking scores only the candidates of each query, with the scores of MTEB', async () => {
  const results = await searchFolder(
    new FolderTask(),
    new Map(Object.entries(expected.top_ranked)),
  );

  assert.deepEqual(results, asMaps(expected.rerank));
});

test('a subset with more than one language is read as English, as in MTEB', async () => {
  const results = await searchFolder(
    new FolderTask(['eng-Latn', 'deu-Latn']),
    null,
  );

  assert.deepEqual(results, asMaps(expected.full));
});

test('each word has the stem that PyStemmer 3.1.0 gives', () => {
  const { stemmer } = new BM25Tokenizer('eng');
  assert.ok(stemmer);
  const words = expected.stems.map(([word]) => word);

  const stems = stemmer.stemWords(words);

  assert.deepEqual(
    words.map((word, index) => [word, stems[index]]),
    expected.stems,
  );
});

for (const run of methodRuns) {
  const name = `${run.folder} ${JSON.stringify(run.kwargs)}`;

  test(`each document of each query has the float32 score that MTEB gives with ${name}, to the last bit`, async () => {
    const results = await searchFolder(
      new FolderTask(['eng-Latn'], FOLDERS[run.folder]),
      null,
      run.kwargs,
    );

    assert.deepEqual(results, asMaps(run.full));
  });

  test(`evaluate gives the main score of MTEB with ${name}`, async () => {
    const result = await evaluate(
      bm25S.loadModel(run.kwargs),
      new FolderTask(['eng-Latn'], FOLDERS[run.folder]),
      { cache: null },
    );

    assert.equal(
      result.taskResults[0]?.scores['test']?.[0]?.['main_score'],
      run.main_score,
    );
  });
}

for (const run of languagesExpected.runs) {
  const name = `${run.folder} ${JSON.stringify(run.kwargs)}`;
  const folder = LANGUAGE_FOLDERS[run.folder];

  test(`each document of each query has the float32 score that MTEB gives in ${name}, to the last bit`, async () => {
    const results = await searchFolder(
      new FolderTask(folder.evalLangs, folder),
      null,
      run.kwargs,
    );

    assert.deepEqual(results, asMaps(run.full));
  });

  test(`evaluate gives the main score of MTEB in ${name}`, async () => {
    const result = await evaluate(
      bm25S.loadModel(run.kwargs),
      new FolderTask(folder.evalLangs, folder),
      { cache: null },
    );

    assert.equal(
      result.taskResults[0]?.scores['test']?.[0]?.['main_score'],
      run.main_score,
    );
  });

  test(`the experiment of ${name} has the names that MTEB gives it`, () => {
    const meta = bm25S.loadModel(run.kwargs).mtebModelMeta;

    assert.deepEqual(
      [meta.experimentName, meta.modelNameWithExperiment],
      [run.experiment_name, run.model_name_with_experiment],
    );
  });
}

function decode({ ids, vocab }: Tokenized): (string | undefined)[][] {
  const tokens = new Map(Array.from(vocab, ([token, id]) => [id, token]));
  return ids.map((docIds) => docIds.map((id) => tokens.get(id)));
}

test('each language of MTEB has the stopwords key, the stemmer and the tokens of documents and queries that MTEB gives it', () => {
  const settings = languagesExpected.languages.map(({ language }) => {
    const tokenizer = new BM25Tokenizer(language);
    const tokens = decode(
      tokenizer.fitTransform(languagesExpected.probe_corpus),
    );
    return {
      language,
      stopwords_key: tokenizer.stopwordsKey,
      stems: tokenizer.stemmer?.stemWords(languagesExpected.probe) ?? null,
      tokens,
      query_tokens: decode(
        tokenizer.transform(languagesExpected.probe_queries),
      ),
    };
  });

  assert.deepEqual(settings, languagesExpected.languages);
});

for (const run of languagesExpected.function_runs) {
  test(`a function as the tokenizer gives the float32 scores of MTEB in ${run.folder} ${JSON.stringify(run.kwargs)}, to the last bit`, async () => {
    const folder = LANGUAGE_FOLDERS[run.folder];
    const task = new FolderTask(folder.evalLangs, folder);
    await task.loadData();
    const split = task.dataset?.get('default')?.get('test');
    assert.ok(split);
    const location = {
      taskMetadata: task.metadata,
      hfSplit: 'test',
      hfSubset: 'default',
      encodeKwargs: {},
    };
    const model = new BM25Search({
      modelMeta: bm25S,
      tokenizer: (text) => text.split(' '),
      stopwords: run.kwargs.stopwords,
      freqThreshold: run.kwargs.freq_threshold,
    });

    await model.index(split.corpus, location);
    const results = await model.search(split.queries, {
      ...location,
      topK: 100,
      topRanked: null,
    });

    assert.deepEqual(results, asMaps(run.full));
  });
}

test('a function as the tokenizer of loadModel makes the experiment name throw the error of MTEB', () => {
  const meta = bm25S.loadModel({
    tokenizer: (text) => text.split(' '),
  }).mtebModelMeta;

  assert.throws(() => meta.experimentName, {
    message: languagesExpected.load_model_error,
  });
});
