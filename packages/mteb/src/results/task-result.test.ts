import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { TaskMetadata } from '../abstasks/task-metadata.ts';
import type { PhaseTiming } from '../timing.ts';
import { MTEB_VERSION, type ResultTask, TaskResult } from './task-result.ts';

const PYTHON_RESULT = join(
  import.meta.dirname,
  'fixtures/python-mteb-2.26.28/zukhruf-gvc.json.txt',
);

// The DummyTask of MTEB's tests/test_results/test_task_results.py. A result
// reads only the metadata, the splits, the subsets and isAggregate of a task.
function dummyTask(
  options: { evalSplits?: string[]; hfSubsets?: string[] } = {},
): ResultTask {
  const metadata = new TaskMetadata({
    name: 'dummy_task',
    description: 'dummy task for testing',
    dataset: { revision: '1.0', path: 'dummy_dataset' },
    type: 'Classification',
    category: 't2t',
    evalLangs: new Map([
      ['en-de', ['eng-Latn', 'deu-Latn']],
      ['en-fr', ['eng-Latn', 'fra-Latn']],
    ]),
    mainScore: 'main_score',
    evalSplits: ['train'],
    domains: [],
    reference: 'https://www.noreference.com',
    date: ['2024-05-02', '2024-05-03'],
    taskSubtypes: [],
    license: 'mit',
    annotationsCreators: 'derived',
    dialect: [],
    bibtexCitation: '',
    modalities: ['text'],
    sampleCreation: 'created',
    supersededBy: 'newer_task',
  });
  return {
    metadata,
    evalSplits: options.evalSplits ?? metadata.evalSplits,
    hfSubsets: options.hfSubsets ?? metadata.hfSubsets,
    isAggregate: false,
  };
}

function dummyResult(): TaskResult {
  return TaskResult.fromTaskResults(
    dummyTask(),
    new Map([
      [
        'train',
        new Map([
          ['en-de', { main_score: 0.5 }],
          ['en-fr', { main_score: 0.6 }],
        ]),
      ],
    ]),
    100,
  );
}

function phase(
  name: string,
  start: number,
  end: number,
  subset: string,
): PhaseTiming {
  return { name, start, end, split: 'test', subset };
}

test('getScore averages the main scores, and of one language only its subsets (test_task_results_get_score)', () => {
  const result = dummyResult();

  const scores = [
    result.getScore(),
    result.getScore({ languages: ['eng'] }),
    result.getScore({ languages: ['fra'] }),
  ];

  assert.deepEqual(scores, [0.55, 0.55, 0.6]);
});

test('getScore of a script keeps the subsets in that script (test_task_results_get_score_scripts)', () => {
  const result = TaskResult.fromValidated({
    taskName: 'dummy_task',
    datasetRevision: '1.0',
    mtebVersion: '2.0.0',
    evaluationTime: 1,
    scores: {
      test: [
        { hf_subset: 'srp-Cyrl', languages: ['srp-Cyrl'], main_score: 0.2 },
        { hf_subset: 'srp-Latn', languages: ['srp-Latn'], main_score: 0.8 },
      ],
    },
  });

  const scores = [
    result.getScore({ scripts: ['Cyrl'] }),
    result.getScore({ scripts: ['Latn'] }),
    result.getScore({ scripts: ['Cyrl', 'Latn'] }),
    result.getScore({ languages: ['srp'], scripts: ['Latn'] }),
  ];

  assert.deepEqual(scores, [0.2, 0.8, 0.5, 0.8]);
});

test('toDict gives the scores of each subset with its languages and the MTEB version (test_task_results_to_dict)', () => {
  const result = dummyResult();

  const dict = result.toDict();

  assert.deepEqual(dict, {
    dataset_revision: '1.0',
    task_name: 'dummy_task',
    mteb_version: MTEB_VERSION,
    evaluation_time: 100,
    evaluation_phases: null,
    date: null,
    kg_co2_emissions: null,
    scores: {
      train: [
        {
          main_score: 0.5,
          hf_subset: 'en-de',
          languages: ['eng-Latn', 'deu-Latn'],
          mteb_version: MTEB_VERSION,
        },
        {
          main_score: 0.6,
          hf_subset: 'en-fr',
          languages: ['eng-Latn', 'fra-Latn'],
          mteb_version: MTEB_VERSION,
        },
      ],
    },
  });
});

test('validateAndFilterScores keeps the splits and subsets of the task (test_task_results_validate_and_filter)', () => {
  const result = TaskResult.fromTaskResults(
    dummyTask(),
    new Map([
      [
        'train',
        new Map([
          ['en-de', { main_score: 0.5 }],
          ['en-fr', { main_score: 0.6 }],
        ]),
      ],
      [
        'test',
        new Map([
          ['en-de', { main_score: 0.3 }],
          ['en-fr', { main_score: 0.4 }],
        ]),
      ],
    ]),
    100,
  );

  const both = result.validateAndFilterScores(
    dummyTask({ evalSplits: ['train', 'test'] }),
  );
  const test = result.validateAndFilterScores(
    dummyTask({ evalSplits: ['test'] }),
  );
  const german = result.validateAndFilterScores(
    dummyTask({ evalSplits: ['train', 'test'], hfSubsets: ['en-de'] }),
  );

  assert.deepEqual(Object.keys(both.scores).sort(), ['test', 'train']);
  assert.equal(both.getScore(), (0.5 + 0.6 + 0.3 + 0.4) / 4);
  assert.deepEqual(Object.keys(test.scores), ['test']);
  assert.equal(test.getScore(), (0.3 + 0.4) / 2);
  assert.deepEqual(Object.keys(german.scores).sort(), ['test', 'train']);
  assert.equal(german.getScore(), (0.5 + 0.3) / 2);
});

test('validateAndFilterScores adds a NaN main score for each subset and split that the result lacks', () => {
  const result = dummyResult();
  const task = dummyTask({ evalSplits: ['train', 'test'] });

  const filtered = result.validateAndFilterScores(task);

  assert.deepEqual(filtered.scores['test'], [
    {
      hf_subset: 'en-de',
      main_score: NaN,
      languages: ['eng-Latn', 'deu-Latn'],
    },
    {
      hf_subset: 'en-fr',
      main_score: NaN,
      languages: ['eng-Latn', 'fra-Latn'],
    },
  ]);
  assert.equal(filtered.getScore({ splits: ['train'] }), 0.55);
});

test('each subset of a result has the MTEB version (test_per_subset_mteb_version)', () => {
  const result = dummyResult();

  const versions = Object.values(result.scores)
    .flat()
    .map((scores) => scores['mteb_version']);

  assert.deepEqual(versions, [MTEB_VERSION, MTEB_VERSION]);
});

test('merge keeps the version of each subset and gives the range as the version (test_merge_across_mteb_versions)', () => {
  const existing = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '2.12.4',
    scores: {
      train: [
        {
          main_score: 0.5,
          hf_subset: 'en-de',
          languages: ['eng-Latn', 'deu-Latn'],
          mteb_version: '2.12.4',
        },
      ],
    },
    evaluationTime: 50,
    kgCo2Emissions: 0.05,
  });
  const newer = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '2.20.1',
    scores: {
      train: [
        {
          main_score: 0.6,
          hf_subset: 'en-fr',
          languages: ['eng-Latn', 'fra-Latn'],
          mteb_version: '2.20.1',
        },
      ],
    },
    evaluationTime: 60,
    kgCo2Emissions: 0.02,
  });

  const mergeable = existing.isMergeable(newer);
  const merged = existing.merge(newer);

  assert.equal(mergeable, true);
  const subsets = Object.fromEntries(
    (merged.scores['train'] ?? []).map((scores) => [
      scores['hf_subset'],
      scores['mteb_version'],
    ]),
  );
  assert.deepEqual(subsets, { 'en-de': '2.12.4', 'en-fr': '2.20.1' });
  assert.equal(merged.mtebVersion, '2.12.4-2.20.1');
  assert.ok(Math.abs((merged.kgCo2Emissions ?? 0) - 0.07) < 1e-12);
});

test('merge gives a subset without a version the version of its result (test_merge_without_per_subset_version)', () => {
  const existing = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '2.12.4',
    scores: {
      train: [
        {
          main_score: 0.5,
          hf_subset: 'en-de',
          languages: ['eng-Latn', 'deu-Latn'],
        },
      ],
    },
    evaluationTime: 50,
    kgCo2Emissions: 0.05,
  });
  const newer = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '2.20.1',
    scores: {
      train: [
        {
          main_score: 0.6,
          hf_subset: 'en-fr',
          languages: ['eng-Latn', 'fra-Latn'],
          mteb_version: '2.20.1',
        },
      ],
    },
    evaluationTime: 60,
    kgCo2Emissions: null,
  });

  const merged = existing.merge(newer);

  const versions = (merged.scores['train'] ?? []).map(
    (scores) => scores['mteb_version'],
  );
  assert.deepEqual(versions, ['2.12.4', '2.20.1']);
  assert.equal(merged.mtebVersion, '2.12.4-2.20.1');
  assert.equal(merged.kgCo2Emissions, 0.05);
});

test('the version range orders versions by PEP 440, not as text', () => {
  const versions = [
    ['2.9.0', '2.10.0'],
    ['2.10.0rc1', '2.10.0'],
    ['2.10.0.dev3', '2.10.0a1'],
    ['2.10.0', '2.10.0.post1'],
  ];

  const ranges = versions.map(([low = '', high = '']) => {
    const subset = (name: string, version: string) =>
      new TaskResult({
        datasetRevision: '1.0',
        taskName: 'dummy_task',
        mtebVersion: version,
        scores: {
          train: [
            { main_score: 0.5, hf_subset: name, languages: ['eng-Latn'] },
          ],
        },
        evaluationTime: 1,
      });
    return subset('b', high).merge(subset('a', low)).mtebVersion;
  });

  assert.deepEqual(ranges, [
    '2.9.0-2.10.0',
    '2.10.0rc1-2.10.0',
    '2.10.0.dev3-2.10.0a1',
    '2.10.0-2.10.0.post1',
  ]);
});

test('fromDisk reads a result whose version is a range (test_from_disk_with_multiversion_range)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-task-result-',
  );
  const folder = directory.path;
  const path = join(folder, 'result.json');
  new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '2.12.16-2.15.4',
    scores: {
      train: [
        {
          main_score: 0.5,
          hf_subset: 'en-de',
          languages: ['eng-Latn', 'deu-Latn'],
          mteb_version: '2.12.16',
        },
        {
          main_score: 0.6,
          hf_subset: 'en-fr',
          languages: ['eng-Latn', 'fra-Latn'],
          mteb_version: '2.15.4',
        },
      ],
    },
    evaluationTime: 50,
  }).toDisk(path);

  const loaded = TaskResult.fromDisk(path);

  assert.equal(loaded.mtebVersion, '2.12.16-2.15.4');
});

test('fromDisk refuses the result format of MTEB before 1.11.0', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-task-result-',
  );
  const folder = directory.path;
  const path = join(folder, 'result.json');
  writeFileSync(
    path,
    JSON.stringify({
      mteb_dataset_name: 'Banking77Classification',
      test: { accuracy: 0.5, evaluation_time: 1 },
    }),
  );

  assert.throws(() => TaskResult.fromDisk(path), /before 1\.11\.0/u);
});

test('plotEvaluationPhases draws each phase with its duration (test_task_result_timings)', () => {
  const result = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '1.0.0',
    scores: {},
    evaluationTime: 4.5,
    evaluationPhases: [
      phase('load data', 0, 1.5, 'en'),
      phase('encode', 1.5, 4.5, 'en'),
    ],
  });

  const plot = result.plotEvaluationPhases();

  assert.match(plot, /load data/u);
  assert.match(plot, /encode/u);
  assert.match(plot, /3\.0s/u);
});

test('merge adds the evaluation times and moves the phases of the new result after the old ones (test_merge_evaluation_phases)', () => {
  const first = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '1.0.0',
    scores: {},
    evaluationTime: 5,
    evaluationPhases: [
      phase('load data', 0, 1.5, 'en'),
      phase('encode', 1.5, 4.5, 'en'),
    ],
  });
  const second = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '1.0.0',
    scores: {},
    evaluationTime: 8,
    evaluationPhases: [
      phase('load data', 0, 2, 'fr'),
      phase('encode', 2, 6, 'fr'),
    ],
  });
  const untimed = new TaskResult({
    datasetRevision: '1.0',
    taskName: 'dummy_task',
    mtebVersion: '1.0.0',
    scores: {},
    evaluationTime: null,
    evaluationPhases: first.evaluationPhases,
  });

  const merged = first.merge(second);
  const fallback = untimed.merge(second);

  assert.equal(merged.evaluationTime, 13);
  assert.deepEqual(merged.evaluationPhases, [
    phase('load data', 0, 1.5, 'en'),
    phase('encode', 1.5, 4.5, 'en'),
    phase('load data', 5, 7, 'fr'),
    phase('encode', 7, 11, 'fr'),
  ]);
  assert.equal(fallback.evaluationTime, 8);
  assert.deepEqual(fallback.evaluationPhases, [
    phase('load data', 0, 1.5, 'en'),
    phase('encode', 1.5, 4.5, 'en'),
    phase('load data', 4.5, 6.5, 'fr'),
    phase('encode', 6.5, 10.5, 'fr'),
  ]);
});

test('getMissingEvaluations names the splits and subsets that the result lacks', () => {
  const result = dummyResult();

  const missing = result.getMissingEvaluations(
    dummyTask({ evalSplits: ['train', 'test'] }),
  );
  const none = result.getMissingEvaluations(dummyTask());

  assert.deepEqual(missing, new Map([['test', ['en-de', 'en-fr']]]));
  assert.equal(none.size, 0);
});

test('onlyMainScore keeps the subset, the main score and the languages', () => {
  const result = TaskResult.fromTaskResults(
    dummyTask(),
    new Map([['train', new Map([['en-de', { main_score: 0.5, f1: 0.4 }]])]]),
    1,
  );

  const main = result.onlyMainScore();

  assert.deepEqual(main.scores, {
    train: [
      {
        hf_subset: 'en-de',
        main_score: 0.5,
        languages: ['eng-Latn', 'deu-Latn'],
      },
    ],
  });
});

test('a result that Python MTEB 2.26.28 wrote reads and writes back with the same scores and NaN tokens', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-task-result-',
  );
  const folder = directory.path;
  const result = TaskResult.fromDisk(PYTHON_RESULT);
  const path = join(folder, 'zukhruf-gvc.json');

  result.toDisk(path);

  const written = readFileSync(path, 'utf8');
  const original = readFileSync(PYTHON_RESULT, 'utf8');
  // Python writes an integral float as 1.0 and the date with microseconds.
  const normalize = (text: string) =>
    text
      .replaceAll(/(\d)\.0(,?)$/gmu, '$1$2')
      .replace(/"date": [\d.]+/u, '"date"');
  assert.equal(normalize(written), normalize(original));
  assert.equal(result.date?.toISOString(), '2026-10-28T08:52:02.003Z');
  assert.match(written, /"date": 1793177522\.003,/u);
  assert.equal(result.getScore(), 0.96995);
  assert.ok(
    Number.isNaN(result.scores['test']?.[0]?.['nauc_recall_at_20_max']),
  );
});

test('isMergeable refuses another task and another dataset revision, and raises when asked', () => {
  const result = dummyResult();
  const other = new TaskResult({ ...initOf(result), taskName: 'other_task' });
  const revised = new TaskResult({ ...initOf(result), datasetRevision: '2.0' });

  const outcomes = [
    result.isMergeable(other),
    result.isMergeable(revised),
    result.isMergeable(revised, { criteria: ['mteb_version'] }),
    result.isMergeable(dummyTask()),
  ];

  assert.deepEqual(outcomes, [false, false, true, true]);
  assert.throws(
    () => result.isMergeable(other, { raiseError: true }),
    /different tasks \(dummy_task and other_task\)/u,
  );
});

function initOf(result: TaskResult) {
  return {
    datasetRevision: result.datasetRevision,
    taskName: result.taskName,
    mtebVersion: result.mtebVersion,
    scores: result.scores,
    evaluationTime: result.evaluationTime,
  };
}
