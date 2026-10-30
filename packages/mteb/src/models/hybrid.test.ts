import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { ResultCache } from '../cache/result-cache.ts';
import { evaluate } from '../evaluate.ts';
import {
  type FusionFunction,
  HybridSearch,
  fuseDbsf,
  fuseRrf,
} from './hybrid-wrappers.ts';
import { bm25S } from './model-implementations/bm25.ts';

const BM25_FOLDER = join(
  import.meta.dirname,
  'model-implementations/fixtures/bm25',
);

class FolderTask extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'HybridFixture',
        description: 'The hybrid search fixture of @zukhruf/mteb.',
        dataset: { path: BM25_FOLDER, revision: '1' },
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

const sumOfScores: FusionFunction = (queryScoresList) => {
  const fused = new Map<string, number>();
  for (const scores of queryScoresList)
    for (const [doc, score] of scores)
      fused.set(doc, (fused.get(doc) ?? 0) + score);
  return fused;
};

test('a hybrid of one model stops, with the message of MTEB', () => {
  assert.throws(
    () => new HybridSearch({ models: [bm25S.loadModel()] }),
    new RangeError('At least two models must be provided for hybrid search.'),
  );
});

test('weights of another length than the models stop the hybrid, with the message of MTEB', () => {
  assert.throws(
    () =>
      new HybridSearch({
        models: [bm25S.loadModel(), bm25S.loadModel()],
        weights: [1],
      }),
    new RangeError('Length of weights must match the number of models.'),
  );
});

test('a subModelTopK of 0 stops the hybrid, with the message of MTEB', () => {
  assert.throws(
    () =>
      new HybridSearch({
        models: [bm25S.loadModel(), bm25S.loadModel()],
        subModelTopK: 0,
      }),
    new RangeError('sub_model_top_k must be greater than 0'),
  );
});

test('an rrfK that is not an integer stops the hybrid with a TypeError, and a negative one with a RangeError', () => {
  const models = [bm25S.loadModel(), bm25S.loadModel()];

  assert.throws(
    () => new HybridSearch({ models, rrfK: 1.5 }),
    new TypeError('rrf_k must be an integer'),
  );
  assert.throws(
    () => new HybridSearch({ models, rrfK: -1 }),
    new RangeError('rrf_k must be greater than or equal to 0'),
  );
});

test('a fusion function names the hybrid by its name, and a function without a name as custom', () => {
  const models = [bm25S.loadModel(), bm25S.loadModel()];
  // An arrow function in an array literal gets no name.
  const [anonymous] = [
    (...args: Parameters<FusionFunction>) => sumOfScores(...args),
  ];
  assert.equal(anonymous.name, '');

  const named = new HybridSearch({ models, fusionStrategy: sumOfScores });
  const unnamed = new HybridSearch({ models, fusionStrategy: anonymous });

  assert.deepEqual(
    [named.mtebModelMeta.name, unnamed.mtebModelMeta.name],
    [
      'mteb/baseline-hybrid-sumOfScores-baseline-bm25s-baseline-bm25s',
      'mteb/baseline-hybrid-custom-baseline-bm25s-baseline-bm25s',
    ],
  );
});

test('subModelTopK limits the documents that each sub-model gives the fusion', async () => {
  const task = new FolderTask();
  await task.loadData();
  const split = task.dataset?.get('default')?.get('test');
  assert.ok(split);
  const location = {
    taskMetadata: task.metadata,
    hfSplit: 'test',
    hfSubset: 'default',
    encodeKwargs: {},
  };
  const searchQ01 = async (subModelTopK?: number) => {
    const model = new HybridSearch({
      models: [bm25S.loadModel(), bm25S.loadModel()],
      fusionStrategy: 'rsf',
      ...(subModelTopK === undefined ? {} : { subModelTopK }),
    });
    await model.index(split.corpus, location);
    const results = await model.search(split.queries, {
      ...location,
      topK: 1,
    });
    return [...(results.get('q01') ?? [])];
  };

  const [one, all] = [await searchQ01(1), await searchQ01()];

  // With one document, each sub-model normalizes its only score to 0.5;
  // with the default of 100, the best document normalizes to 1.
  assert.deepEqual([one, all], [[['d01', 0.5]], [['d01', 1]]]);
});

test('evaluate keeps the result of a hybrid under the name of MTEB and the revision of an empty ModelMeta', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-hybrid-');
  const cache = new ResultCache(directory.path);

  await evaluate(
    new HybridSearch({ models: [bm25S.loadModel(), bm25S.loadModel()] }),
    new FolderTask(),
    { cache },
  );

  assert.ok(
    existsSync(
      join(
        directory.path,
        'results/mteb__baseline-hybrid-rrf-baseline-bm25s-baseline-bm25s/no_revision_available/HybridFixture.json',
      ),
    ),
  );
});

test('rrfK reaches the Reciprocal Rank Fusion of the hybrid', () => {
  const hybrid = new HybridSearch({
    models: [bm25S.loadModel(), bm25S.loadModel()],
    rrfK: 0,
  });

  const fused = hybrid.fuse([new Map([['a', 1]]), new Map([['a', 2]])]);

  // Each model ranks a first: 0.5 / (0 + 1) twice.
  assert.deepEqual(fused, new Map([['a', 1]]));
});

test('a fusion with another number of weights than score maps stops, as zip(strict=True) does', () => {
  const scores = [new Map([['a', 1]])];

  assert.throws(
    () => fuseDbsf(scores, [0.5, 0.5]),
    new RangeError('zip() argument 2 is longer than argument 1'),
  );
  assert.throws(
    () => fuseRrf([...scores, ...scores], [1]),
    new RangeError('zip() argument 2 is shorter than argument 1'),
  );
});
