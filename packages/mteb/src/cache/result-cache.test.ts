import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { ModelMeta } from '../models/model-meta.ts';
import { type ResultTask, TaskResult } from '../results/task-result.ts';
import { LoadExperimentEnum, ResultCache } from './result-cache.ts';

const PYTHON_FILES = join(
  import.meta.dirname,
  '../results/fixtures/python-mteb-2.26.28',
);

function result(
  taskName: string,
  scores: Record<string, number> = { default: 0.5 },
): TaskResult {
  return new TaskResult({
    datasetRevision: '1.0',
    taskName,
    mtebVersion: '2.26.28',
    scores: {
      test: Object.entries(scores).map(([subset, score]) => ({
        main_score: score,
        hf_subset: subset,
        languages: ['eng-Latn'],
      })),
    },
    evaluationTime: 1,
  });
}

function meta(
  name: string,
  revision: string,
  experimentKwargs: Record<string, unknown> | null = null,
): ModelMeta {
  return ModelMeta.createEmpty({ name, revision, experimentKwargs });
}

function task(name: string, subsets: string[]): ResultTask {
  const metadata = new TaskMetadata({
    name,
    description: 'a retrieval task for the cache tests',
    dataset: { path: 'local/task', revision: '1.0' },
    type: 'Retrieval',
    category: 't2t',
    evalLangs: new Map(subsets.map((subset) => [subset, ['eng-Latn']])),
    mainScore: 'ndcg_at_10',
  });
  return {
    metadata,
    evalSplits: metadata.evalSplits,
    hfSubsets: metadata.hfSubsets,
    isAggregate: false,
  };
}

test('loadTaskResult reads a result with its revision, and without one the revision that changed last (test_result_cache)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  cache.saveToCache(result('Task', { default: 0.1 }), meta('org/model', 'old'));
  cache.saveToCache(result('Task', { default: 0.2 }), meta('org/model', 'new'));
  const oldFolder = join(folder, 'results', 'org__model', 'old');
  utimesSync(oldFolder, new Date(2020, 0, 1), new Date(2020, 0, 1));

  const pinned = cache.loadTaskResult('Task', 'org/model', {
    modelRevision: 'old',
    raiseIfNotFound: true,
  });
  const latest = cache.loadTaskResult('Task', 'org/model', {
    raiseIfNotFound: true,
  });
  const missing = cache.loadTaskResult('Other', 'org/model', {
    modelRevision: 'old',
  });

  assert.equal(pinned?.getScore(), 0.1);
  assert.equal(latest?.getScore(), 0.2);
  assert.equal(missing, null);
  assert.throws(
    () =>
      cache.loadTaskResult('Other', 'org/model', {
        modelRevision: 'old',
        raiseIfNotFound: true,
      }),
    /Results for org\/model on Other not found/u,
  );
});

test('getCachePaths drops results without model metadata, adds the remote folder and filters by model (test_get_cache_path)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  cache.saveToCache(result('A'), meta('org/model', 'r1'));
  cache.saveToCache(result('B'), meta('org/other', 'r1'));
  const bare = join(folder, 'results', 'org__bare', 'r1');
  mkdirSync(bare, { recursive: true });
  result('A').toDisk(join(bare, 'A.json'));
  const remote = join(folder, 'remote', 'results', 'org__remote', 'r1');
  mkdirSync(remote, { recursive: true });
  result('C').toDisk(join(remote, 'C.json'));

  const all = cache.getCachePaths({
    requireModelMeta: false,
    includeRemote: false,
  });
  const withMeta = cache.getCachePaths({
    requireModelMeta: true,
    includeRemote: false,
  });
  const withRemote = cache.getCachePaths({
    requireModelMeta: false,
    includeRemote: true,
  });
  const ofModel = cache.getCachePaths({
    models: ['org/model'],
    requireModelMeta: false,
  });

  assert.equal(all.length, 3);
  assert.equal(withMeta.length, 2);
  assert.equal(withRemote.length, 4);
  assert.deepEqual(ofModel, [
    join(folder, 'results', 'org__model', 'r1', 'A.json'),
  ]);
});

test('getModels and getTaskNames list each model and task once (test_get_models_and_tasks, test_no_duplicates_in_models, test_no_duplicates_in_tasks)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  for (const name of ['A', 'B'])
    for (const revision of ['r1', 'r2'])
      cache.saveToCache(result(name), meta('org/model', revision));

  const models = cache.getModels();
  const tasks = cache.getTaskNames();

  assert.deepEqual(models, [
    ['org__model', 'r1'],
    ['org__model', 'r2'],
  ]);
  assert.deepEqual(tasks, ['A', 'B']);
});

test('loadResults gives one model result for each model and revision, and only the named models (test_load_results, test_load_result_specific_model)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  cache.saveToCache(result('A'), meta('org/model', 'r1'));
  cache.saveToCache(result('B'), meta('org/model', 'r1'));
  cache.saveToCache(result('A'), meta('org/other', 'r2'));

  const all = cache.loadResults();
  const one = cache.loadResults({
    models: ['org/other'],
    requireModelMeta: false,
  });

  assert.deepEqual(
    all.modelResults.map((model) => [
      model.modelName,
      model.modelRevision,
      model.taskNames,
    ]),
    [
      ['org/model', 'r1', ['A', 'B']],
      ['org/other', 'r2', ['A']],
    ],
  );
  assert.deepEqual(one.modelNames, ['org/other']);
});

test('a ModelMeta selects its revision and a model name selects every revision (test_filter_with_modelmeta, test_filter_with_string_models)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  const pinned = meta('org/model', 'r1');
  cache.saveToCache(result('A'), pinned);
  cache.saveToCache(result('B'), pinned);
  cache.saveToCache(result('A'), meta('org/model', 'revision'));
  cache.saveToCache(result('B'), meta('not/existing', 'revision'));

  const byMeta = cache.getCachePaths({ models: [pinned] });
  const byName = cache.getCachePaths({ models: ['org/model'] });

  assert.deepEqual(byMeta, [
    join(folder, 'results', 'org__model', 'r1', 'A.json'),
    join(folder, 'results', 'org__model', 'r1', 'B.json'),
  ]);
  assert.deepEqual(byName, [
    join(folder, 'results', 'org__model', 'r1', 'A.json'),
    join(folder, 'results', 'org__model', 'r1', 'B.json'),
    join(folder, 'results', 'org__model', 'revision', 'A.json'),
  ]);
});

test('loadResults with validateAndFilter fills the subsets of the task that a model lacks with NaN (test_cache_load_different_subsets)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  const twoSubsets = task('Belebele', ['arab', 'latn']);
  cache.saveToCache(
    result('Belebele', { arab: 0.01568 }),
    meta('org/arabic', 'r1'),
  );
  cache.saveToCache(
    result('Belebele', { arab: 0.0103, latn: 0.0104 }),
    meta('org/both', 'r1'),
  );

  const raw = cache.loadResults({ tasks: [twoSubsets] });
  const filtered = cache.loadResults({
    tasks: [twoSubsets],
    validateAndFilter: true,
  });

  const [arabic, both] = raw.modelResults;
  assert.equal(arabic?.taskResults[0]?.scores['test']?.length, 1);
  assert.equal(arabic?.taskResults[0]?.getScore(), 0.01568);
  assert.equal(both?.taskResults[0]?.scores['test']?.length, 2);
  const [arabicFiltered, bothFiltered] = filtered.modelResults;
  assert.equal(arabicFiltered?.taskResults[0]?.scores['test']?.length, 2);
  assert.ok(Number.isNaN(arabicFiltered?.taskResults[0]?.getScore()));
  assert.equal(bothFiltered?.taskResults[0]?.getScore(), 0.01035);
});

test('loadResults selects experiments by name, by keyword arguments or not at all (test_load_experiment_results)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  const params1 = { a: 'test' };
  const params2 = { a: 'test', b: 'test2' };
  const base = meta('mteb/baseline-random-encoder', 'r1');
  const second = meta('mteb/baseline-random-encoder', 'r1', params2);
  cache.saveToCache(result('MockRetrievalTask'), base);
  cache.saveToCache(
    result('MockRetrievalTask'),
    meta('mteb/baseline-random-encoder', 'r1', params1),
  );
  cache.saveToCache(result('MockRetrievalTask'), second);

  const count = (options: Parameters<ResultCache['loadResults']>[0]) =>
    cache.loadResults(options).modelResults.length;
  const named = cache.loadResults({
    loadExperiments: LoadExperimentEnum.MATCH_KWARGS,
    experimentKwargs: params1,
  });
  const byName = cache.loadResults({
    models: ['mteb/baseline-random-encoder'],
    loadExperiments: LoadExperimentEnum.MATCH_NAME,
    experimentKwargs: params2,
  });

  assert.equal(count({}), 1);
  assert.equal(cache.loadResults().modelResults[0]?.experimentName, null);
  assert.equal(count({ experimentKwargs: [params1, params2] }), 2);
  assert.equal(count({ loadExperiments: LoadExperimentEnum.MATCH_NAME }), 3);
  assert.equal(
    count({ loadExperiments: LoadExperimentEnum.NO_EXPERIMENTS }),
    1,
  );
  assert.deepEqual(
    named.modelResults.map((model) => model.experimentName),
    ['a_test'],
  );
  assert.deepEqual(
    byName.modelResults.map((model) => model.experimentName),
    ['a_test__b_test2'],
  );
  assert.equal(
    count({
      models: [second],
      loadExperiments: LoadExperimentEnum.MATCH_KWARGS,
    }),
    1,
  );
  assert.equal(
    count({
      models: [second],
      loadExperiments: LoadExperimentEnum.MATCH_NAME,
    }),
    3,
  );
  assert.equal(
    count({
      models: ['mteb/baseline-random-encoder'],
      loadExperiments: LoadExperimentEnum.MATCH_NAME,
    }),
    3,
  );
  assert.equal(count({ experimentKwargs: [params2] }), 1);
});

test('a revision folder without model_meta.json takes the model name and revision from its path (test_plain_revision_folder_unregistered_model_has_no_meta)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  const revision = join(
    folder,
    'results',
    'totally__unregistered-model',
    'some_rev',
  );
  mkdirSync(revision, { recursive: true });
  result('SomeTask').toDisk(join(revision, 'SomeTask.json'));

  const loaded = cache.loadResults({ requireModelMeta: false });

  assert.deepEqual(
    loaded.modelResults.map((model) => [
      model.modelName,
      model.modelRevision,
      model.experimentName,
      model.modelMeta,
    ]),
    [['totally/unregistered-model', 'some_rev', null, null]],
  );
});

test('a model whose model_meta.json has no revision loads with a null revision, as MTEB writes it for a model without one', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  cache.saveToCache(
    result('SomeTask'),
    meta('org/model', 'no_revision_available'),
  );
  const metaPath = join(
    folder,
    'results',
    'org__model',
    'no_revision_available',
    'model_meta.json',
  );
  writeFileSync(
    metaPath,
    readFileSync(metaPath, 'utf8').replace(
      '"revision": "no_revision_available"',
      '"revision": null',
    ),
  );

  const loaded = cache.loadResults();

  assert.deepEqual(
    loaded.modelResults.map((model) => [model.modelName, model.modelRevision]),
    [['org/model', null]],
  );
});

test('a cache inside a folder named experiments still reads its results as results of the model', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(join(folder, 'experiments', 'cache'));
  const model = meta('org/model', 'r1');
  cache.saveToCache(result('A'), model);

  const paths = cache.getCachePaths({ models: [model] });
  const loaded = cache.loadResults({ models: [model] });

  assert.equal(paths.length, 1);
  assert.deepEqual(loaded.modelNames, ['org/model']);
});

test('saveToCache writes the run settings of each split, and splits with the same settings and subsets share a line', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(folder);
  const model = meta('org/model', 'r1');
  const twoSplits = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'Task',
    mtebVersion: '2.26.28',
    scores: {
      test: [
        { main_score: 0.5, hf_subset: 'default', languages: ['eng-Latn'] },
      ],
      dev: [{ main_score: 0.4, hf_subset: 'default', languages: ['eng-Latn'] }],
    },
    evaluationTime: 1,
  });
  cache.saveToCache(twoSplits, model, { encodeKwargs: { batchSize: 32 } });
  cache.saveToCache(result('Other'), model, {
    encodeKwargs: { batchSize: 8 },
  });

  const lines = readFileSync(
    join(folder, 'results', 'org__model', 'r1', 'run_settings.jsonl'),
    'utf8',
  );

  const version =
    '{"mteb": "2.26.28", "torch": null, "sentence-transformers": null, "flash-attn": null, "transformers": null}';
  assert.equal(
    lines,
    `{"task": "Task", "splits": ["dev", "test"], "version": ${version}, "encode_kwargs": {"batch_size": 32}, "subsets": ["default"]}\n` +
      `{"task": "Other", "splits": ["test"], "version": ${version}, "encode_kwargs": {"batch_size": 8}, "subsets": ["default"]}\n`,
  );
});

test('the result folder that Python MTEB 2.26.28 wrote loads with its model metadata, and a new run joins its run settings', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const revision = join(
    folder,
    'results',
    'llama.cpp__embeddinggemma-2',
    '58faf90940886df2d62be555c8765d00dac362c5-Q8_0',
  );
  mkdirSync(revision, { recursive: true });
  for (const name of [
    'zukhruf-gvc.json',
    'model_meta.json',
    'run_settings.jsonl',
  ])
    copyFileSync(join(PYTHON_FILES, `${name}.txt`), join(revision, name));
  const cache = new ResultCache(folder);

  const loaded = cache.loadResults();
  const [model] = loaded.modelResults;
  if (model?.modelMeta === null || model === undefined)
    assert.fail('the model has no metadata');
  cache.saveToCache(result('zukhruf-anthropic-outlets'), model.modelMeta);

  assert.equal(model.modelName, 'llama.cpp/embeddinggemma-2');
  assert.equal(model.taskResults[0]?.getScore(), 0.96995);
  const lines = readFileSync(join(revision, 'run_settings.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /"task": "zukhruf-gvc"/u);
  assert.match(lines[0] ?? '', /"torch": "2\.14\.1"/u);
  assert.match(lines[1] ?? '', /"task": "zukhruf-anthropic-outlets"/u);
});

test('clearCache deletes the cache folder', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-result-cache-',
  );
  const folder = directory.path;
  const cache = new ResultCache(join(folder, 'cache'));
  writeFileSync(join(folder, 'cache', 'file'), '');

  cache.clearCache();

  assert.deepEqual(cache.getCachePaths(), []);
  assert.throws(() => readFileSync(join(folder, 'cache', 'file')));
});
