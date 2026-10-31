import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AbsTaskRetrieval } from '../../abstasks/retrieval.ts';
import { TaskMetadata } from '../../abstasks/task-metadata.ts';
import { evaluate } from '../../evaluate.ts';
import type { ISOLanguageScript } from '../../types/metadata.ts';
import { type BM25Kwargs, BM25Tokenizer, bm25S } from './bm25.ts';

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

const FOLDERS = {
  bm25: { name: 'Bm25Fixture', path: FOLDER },
  methods: { name: 'Bm25MethodsFixture', path: METHODS_FOLDER },
} as const;

class FolderTask extends AbsTaskRetrieval {
  constructor(
    evalLangs: ISOLanguageScript[] = ['eng-Latn'],
    folder: (typeof FOLDERS)[keyof typeof FOLDERS] = FOLDERS.bm25,
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
  const tokenizer = new BM25Tokenizer('eng');
  const words = expected.stems.map(([word]) => word);

  const stems = tokenizer.stemmer.stemWords(words);

  assert.deepEqual(
    words.map((word, index) => [word, stems[index]]),
    expected.stems,
  );
});

test('a task in another language than English stops the index, naming the language', async () => {
  const task = new FolderTask(['deu-Latn']);
  await task.loadData();
  const split = task.dataset?.get('default')?.get('test');
  assert.ok(split);

  await assert.rejects(
    bm25S.loadModel().index(split.corpus, {
      taskMetadata: task.metadata,
      hfSplit: 'test',
      hfSubset: 'default',
      encodeKwargs: {},
    }),
    /BM25Search supports English only: the subset 'default' of the task Bm25Fixture has the language 'deu'\./u,
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
