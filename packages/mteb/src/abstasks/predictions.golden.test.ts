import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { evaluate } from '../evaluate.ts';
import { bm25S } from '../models/model-implementations/bm25.ts';
import { perQueryScores } from '../significance/per-query-scores.ts';
import { AbsTaskRetrieval, readPredictionsFile } from './retrieval.ts';
import { TaskMetadata } from './task-metadata.ts';

// fixtures/predictions/ is a folder dataset whose ids are integer-like, and
// what Python MTEB 2.26.28 gave for it: saved/ holds a predictions file that
// _save_task_predictions wrote, with tied scores; evaluated/ holds the
// predictions file that mteb.evaluate wrote for mteb/baseline-bm25s;
// non-finite/ holds a predictions file of _save_task_predictions with NaN,
// Infinity and -Infinity tokens; expected.json holds the top_ranked of
// convert_to_reranking on saved/ and on non-finite/, the ndcg_cut_10 of each
// query with skip_first_result, and what json.load reads from non-finite/.
// generate.py makes them all.
const FOLDER = join(import.meta.dirname, 'fixtures/predictions');
const SAVED = join(FOLDER, 'saved');
const NON_FINITE = join(FOLDER, 'non-finite');
const FILE_NAME = 'KeyOrder_predictions.json';

type Expected = {
  readonly top_k: number;
  readonly top_ranked: Readonly<Record<string, [string, string[]][]>>;
  readonly per_query: [string, number][];
  // A float that JSON cannot hold is a string.
  readonly non_finite: {
    readonly predictions: [
      string,
      [string, [string, [string, number | string][]][]][],
    ][];
    readonly top_ranked: Readonly<Record<string, [string, string[]][]>>;
  };
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

class KeyOrderTask extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'KeyOrder',
        description: 'The predictions fixture of @zukhruf/mteb.',
        dataset: { path: FOLDER, revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test', 'dev'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
  }
}

test('convertToReranking keeps the documents that MTEB keeps when scores tie at the top_k cut of a file with integer-like ids', async () => {
  const task = await new KeyOrderTask().convertToReranking(
    SAVED,
    expected.top_k,
  );

  for (const split of ['test', 'dev']) {
    const topRanked = task.dataset?.get('default')?.get(split)?.topRanked;
    assert.ok(topRanked);
    assert.deepEqual([...topRanked], expected.top_ranked[split]);
  }
});

test('perQueryScores drops the first result that MTEB drops when the first scores tie in a file with integer-like ids', async () => {
  const task = new KeyOrderTask();
  task.skipFirstResult = true;

  const perQuery = await perQueryScores(task, SAVED);

  assert.deepEqual(perQuery, new Map(expected.per_query));
});

test('evaluate writes the predictions file that MTEB writes, in the order of the search, for each split', async () => {
  await using folder = await new TemporaryFiles().directory(
    'mteb-predictions-',
  );

  await evaluate(bm25S.loadModel(), new KeyOrderTask(), {
    cache: null,
    predictionFolder: folder.path,
  });

  assert.equal(
    readFileSync(join(folder.path, FILE_NAME), 'utf8'),
    readFileSync(join(FOLDER, 'evaluated', FILE_NAME), 'utf8'),
  );
});

test('readPredictionsFile reads the NaN, Infinity and -Infinity tokens that MTEB writes, as json.load does', () => {
  const file = readPredictionsFile(join(NON_FINITE, FILE_NAME));

  assert.deepEqual(
    [...file.subsets].map(([subset, splits]) => [
      subset,
      [...splits].map(([split, queries]) => [
        split,
        [...queries].map(([query, scores]) => [query, [...scores]]),
      ]),
    ]),
    expected.non_finite.predictions.map(([subset, splits]) => [
      subset,
      splits.map(([split, queries]) => [
        split,
        queries.map(([query, scores]) => [
          query,
          scores.map(([document, score]) => [document, Number(score)]),
        ]),
      ]),
    ]),
  );
});

test('convertToReranking keeps the documents that MTEB keeps when a file has NaN and infinite scores', async () => {
  const task = await new KeyOrderTask().convertToReranking(
    NON_FINITE,
    expected.top_k,
  );

  for (const split of ['test', 'dev']) {
    const topRanked = task.dataset?.get('default')?.get(split)?.topRanked;
    assert.ok(topRanked);
    assert.deepEqual([...topRanked], expected.non_finite.top_ranked[split]);
  }
});

test('evaluate refuses a predictions file whose subset is not an object, as MTEB raises a TypeError', async () => {
  await using folder = await new TemporaryFiles().directory(
    'mteb-predictions-',
  );
  writeFileSync(
    join(folder.path, FILE_NAME),
    '{"mteb_model_meta": {"model_name": "mteb/baseline-bm25s", "revision": "0_3_0"}, "default": 5}',
  );

  await assert.rejects(
    evaluate(bm25S.loadModel(), new KeyOrderTask(), {
      cache: null,
      predictionFolder: folder.path,
    }),
    { name: 'TypeError' },
  );
});

test('a predictions file with a trailing comma is refused, as json.load raises', async () => {
  await using folder = await new TemporaryFiles().directory(
    'mteb-predictions-',
  );
  writeFileSync(
    join(folder.path, FILE_NAME),
    readFileSync(join(SAVED, FILE_NAME), 'utf8').replace(
      '"1": 0.2}',
      '"1": 0.2,}',
    ),
  );

  await assert.rejects(new KeyOrderTask().convertToReranking(folder.path), {
    name: 'SyntaxError',
  });
});
