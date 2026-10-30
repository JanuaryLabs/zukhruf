import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { ResultCache } from '../cache/result-cache.ts';
import { ModelMeta } from '../models/model-meta.ts';
import { BenchmarkResults } from './benchmark-results.ts';
import { ModelResult } from './model-result.ts';
import { type ResultTask, TaskResult } from './task-result.ts';

function result(
  taskName: string,
  options: { readonly score?: number; readonly mtebVersion?: string } = {},
): TaskResult {
  return new TaskResult({
    datasetRevision: '1.0',
    taskName,
    mtebVersion: options.mtebVersion ?? '2.26.28',
    scores: {
      test: [
        {
          main_score: options.score ?? 0.5,
          hf_subset: 'default',
          languages: ['eng-Latn'],
        },
      ],
    },
    evaluationTime: 1,
  });
}

function task(name: string): ResultTask {
  const metadata = new TaskMetadata({
    name,
    description: 'a task for the benchmark result tests',
    dataset: { path: 'local/task', revision: '1.0' },
    type: 'STS',
    category: 't2t',
    evalLangs: ['eng-Latn'],
    mainScore: 'cosine_spearman',
    domains: ['News'],
  });
  return {
    metadata,
    evalSplits: metadata.evalSplits,
    hfSubsets: metadata.hfSubsets,
    isAggregate: false,
  };
}

// Two revisions of one model and one revision of another, as the mock
// cache of MTEB's tests has.
function cacheWithResults(folder: string): ResultCache {
  const cache = new ResultCache(folder);
  for (const revision of ['r1', 'r2'])
    for (const name of ['STS12', 'NFCorpus'])
      cache.saveToCache(
        result(name),
        ModelMeta.createEmpty({ name: 'org/model', revision }),
      );
  cache.saveToCache(
    result('STS12'),
    ModelMeta.createEmpty({ name: 'org/other', revision: 'r1' }),
  );
  return cache;
}

test('indexing into the results gives a ModelResult (test_indexing)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-benchmark-results-',
  );
  const folder = directory.path;
  const results = cacheWithResults(folder).loadResults();

  const [first] = results;

  assert.ok(first instanceof ModelResult);
});

test('selectModels selects every revision of a name, one revision, or the revision of a ModelMeta (test_select_models)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-benchmark-results-',
  );
  const folder = directory.path;
  const results = cacheWithResults(folder).loadResults();

  const byName = results.selectModels(['org/model']);
  const byRevision = results.selectModels(['org/model'], ['r2']);
  const byMeta = results.selectModels([
    ModelMeta.createEmpty({ name: 'org/model', revision: 'r1' }),
  ]);

  assert.deepEqual(byName.modelRevisions, [
    { modelName: 'org/model', revision: 'r1' },
    { modelName: 'org/model', revision: 'r2' },
  ]);
  assert.deepEqual(byRevision.modelRevisions, [
    { modelName: 'org/model', revision: 'r2' },
  ]);
  assert.deepEqual(byMeta.modelRevisions, [
    { modelName: 'org/model', revision: 'r1' },
  ]);
  assert.throws(
    () => results.selectModels(['org/model'], []),
    /must be the same/u,
  );
});

test('selectTasks keeps only the given tasks (test_select_tasks)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-benchmark-results-',
  );
  const folder = directory.path;
  const results = cacheWithResults(folder).loadResults();

  const selected = results.selectTasks([task('STS12')]);

  assert.deepEqual(selected.taskNames, ['STS12']);
});

test('selectTasks keeps the model metadata and its experiment (test_select_tasks_preserves_model_meta)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-benchmark-results-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  cache.saveToCache(
    result('MockRetrievalTask'),
    ModelMeta.createEmpty({
      name: 'mteb/baseline-random-encoder',
      revision: 'r1',
      experimentKwargs: { a: 'test' },
    }),
  );
  const [model] = cache.loadResults({ loadExperiments: 'match_name' });

  const filtered = model?.selectTasks([task('MockRetrievalTask')]);

  assert.deepEqual(model?.modelMeta?.experimentKwargs, { a: 'test' });
  assert.deepEqual(filtered?.modelMeta?.experimentKwargs, { a: 'test' });
});

test('joinRevisions keeps one revision for each model and task, the one of the latest MTEB version (test_join_revisions)', () => {
  const results = new BenchmarkResults([
    new ModelResult({
      modelName: 'org/model',
      modelRevision: 'r1',
      taskResults: [result('STS12', { score: 0.1, mtebVersion: '2.10.0' })],
    }),
    new ModelResult({
      modelName: 'org/model',
      modelRevision: 'r2',
      taskResults: [result('STS12', { score: 0.2, mtebVersion: '2.9.0' })],
    }),
  ]);

  const joined = results.joinRevisions();

  assert.deepEqual(joined.modelRevisions, [
    { modelName: 'org/model', revision: 'r1' },
  ]);
  assert.equal(joined.modelResults[0]?.taskResults[0]?.getScore(), 0.1);
});

test('the utility properties list the tasks, languages, models, revisions, task types and domains (test_utility_properties)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-benchmark-results-',
  );
  const folder = directory.path;
  const results = cacheWithResults(folder)
    .loadResults()
    .selectTasks([task('STS12'), task('NFCorpus')]);

  assert.deepEqual(results.taskNames.toSorted(), ['NFCorpus', 'STS12']);
  assert.deepEqual(results.languages, ['eng']);
  assert.deepEqual(results.modelNames, ['org/model', 'org/model', 'org/other']);
  assert.deepEqual(results.taskTypes, ['STS']);
  assert.deepEqual(results.domains, ['News']);
  assert.deepEqual(results.modalities, ['text']);
});

test('toDisk and fromDisk keep the models, the tasks and the scores', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-benchmark-results-',
  );
  const folder = directory.path;
  const results = cacheWithResults(folder).loadResults();
  const path = join(folder, 'out', 'results.json');

  results.toDisk(path);
  const loaded = BenchmarkResults.fromDisk(path);

  assert.deepEqual(loaded.modelRevisions, results.modelRevisions);
  assert.deepEqual(
    loaded.modelResults.map((model) => model.taskNames),
    results.modelResults.map((model) => model.taskNames),
  );
  assert.equal(loaded.modelResults[0]?.modelMeta?.name, 'org/model');
});
