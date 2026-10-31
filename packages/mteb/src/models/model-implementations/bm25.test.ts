import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { AbsTaskRetrieval } from '../../abstasks/retrieval.ts';
import { TaskMetadata } from '../../abstasks/task-metadata.ts';
import { ResultCache } from '../../cache/result-cache.ts';
import { evaluate } from '../../evaluate.ts';
import { BM25Search, bm25S } from './bm25.ts';

// fixtures/bm25/ is a folder dataset and the main score that Python
// mteb.evaluate gave mteb/baseline-bm25s on it (generate.py).
const FOLDER = join(import.meta.dirname, 'fixtures/bm25');

const expected: { readonly main_score: number } = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

class FolderTask extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'Bm25Fixture',
        description: 'The BM25 fixture of @zukhruf/mteb.',
        dataset: { path: FOLDER, revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
  }
}

const LOCATION = { hfSplit: 'test', hfSubset: 'default', encodeKwargs: {} };

test('evaluate gives the main score of Python MTEB and keeps the result under the name and revision of MTEB', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-bm25-');
  const cache = new ResultCache(directory.path);

  const result = await evaluate(bm25S.loadModel(), new FolderTask(), {
    cache,
  });

  assert.equal(
    result.taskResults[0]?.scores['test']?.[0]?.['main_score'],
    expected.main_score,
  );
  assert.ok(
    existsSync(
      join(
        directory.path,
        'results/mteb__baseline-bm25s/0_3_0/Bm25Fixture.json',
      ),
    ),
  );
});

test('k1 is an experiment argument: it reaches the scores and names the folder of the result', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-bm25-');
  const cache = new ResultCache(directory.path);
  const task = new FolderTask();
  await task.loadData();
  const split = task.dataset?.get('default')?.get('test');
  assert.ok(split);
  const location = { ...LOCATION, taskMetadata: task.metadata };
  const plain = bm25S.loadModel();
  await plain.index(split.corpus, location);

  const tuned = bm25S.loadModel({ k1: 0.1 });
  await tuned.index(split.corpus, location);
  await evaluate(tuned, task, { cache });

  assert.deepEqual(tuned.mtebModelMeta.experimentKwargs, { k1: 0.1 });
  assert.notDeepEqual(
    await tuned.search(split.queries, { ...location, topK: 100 }),
    await plain.search(split.queries, { ...location, topK: 100 }),
  );
  assert.ok(
    existsSync(
      join(
        directory.path,
        'results/mteb__baseline-bm25s/0_3_0/experiments/k1_0.1/Bm25Fixture.json',
      ),
    ),
  );
});

test('a search before the index stops, as in MTEB', async () => {
  const task = new FolderTask();

  await assert.rejects(
    bm25S
      .loadModel()
      .search([], { ...LOCATION, taskMetadata: task.metadata, topK: 10 }),
    /Tokenizer not initialized\. Call `index` first\./u,
  );
});

test('a conversation query stops the search with a TypeError', async () => {
  const task = new FolderTask();
  const model = bm25S.loadModel();
  await model.index([{ id: 'd1', text: 'Cats sleep.' }], {
    ...LOCATION,
    taskMetadata: task.metadata,
  });

  await assert.rejects(
    model.search(
      [{ id: 'q1', text: [{ role: 'user', content: 'Do cats sleep?' }] }],
      { ...LOCATION, taskMetadata: task.metadata, topK: 10 },
    ),
    {
      name: 'TypeError',
      message: 'BM25Search searches with text: the query q1 is a conversation.',
    },
  );
});

test('a stemmer name that PyStemmer does not know stops the index, as in MTEB', async () => {
  const task = new FolderTask();
  const model = bm25S.loadModel({ stemmer_language: 'klingon' });

  await assert.rejects(
    model.index([{ id: 'd1', text: 'Cats sleep.' }], {
      ...LOCATION,
      taskMetadata: task.metadata,
    }),
    { message: "Stemming algorithm 'klingon' not found" },
  );
});

test('with a function as the tokenizer, which never stems, a stemmer name that PyStemmer does not know still stops the index, as in MTEB', async () => {
  const task = new FolderTask();
  const model = new BM25Search({
    modelMeta: bm25S,
    tokenizer: (text) => text.split(' '),
    stemmerLanguage: 'klingon',
  });

  await assert.rejects(
    model.index([{ id: 'd1', text: 'Cats sleep.' }], {
      ...LOCATION,
      taskMetadata: task.metadata,
    }),
    { message: "Stemming algorithm 'klingon' not found" },
  );
});
