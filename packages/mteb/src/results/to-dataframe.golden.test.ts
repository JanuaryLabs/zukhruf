import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TaskType } from '../abstasks/task-metadata.ts';
import { ResultCache } from '../cache/result-cache.ts';
import type { Cell, ColumnLabel, DataFrame } from '../dependencies/pandas.ts';
import type { AggregationLevel } from './model-result.ts';
import type { ResultTask } from './task-result.ts';

// fixtures/to-dataframe/ is a result cache that Python MTEB 2.26.28 wrote,
// and each table that MTEB with pandas 3.1.0 made of it. generate.py makes
// both. A float that JSON cannot hold is a string.
const FOLDER = join(import.meta.dirname, 'fixtures/to-dataframe');

type Options = {
  readonly aggregation_level: AggregationLevel;
  readonly format: 'wide' | 'long';
  readonly include_model_revision: boolean;
};
type Table = {
  readonly columns: readonly ColumnLabel[];
  readonly rows: readonly (readonly (Cell | string)[])[];
};
type Expected = {
  readonly model_results: readonly {
    readonly model: readonly [string, string | null, string | null];
    readonly options: Options;
    readonly table: Table;
  }[];
  readonly benchmark_results: readonly {
    readonly options: Options;
    readonly table: Table;
  }[];
  readonly maximum: readonly {
    readonly options: Options;
    readonly table: Table;
  }[];
  readonly empty: Table;
  readonly aggregated: readonly [
    'match_name' | 'no_experiments',
    readonly [string, readonly [string, number | string | null][]][],
  ][];
  readonly experiment_tables: readonly {
    readonly experiment: string;
    readonly options: Options;
    readonly table: Table;
  }[];
  readonly experiment_aggregated: readonly [
    'match_name' | 'no_experiments',
    readonly [
      string,
      readonly [string, readonly [string, number | string | null][]][],
    ][],
  ][];
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

function value(cell: Cell | string): Cell {
  return cell === 'NaN' || cell === 'Infinity' || cell === '-Infinity'
    ? Number(cell)
    : cell;
}

function plain(table: DataFrame | Table): Table {
  return {
    columns: table.columns,
    rows: table.rows.map((row) => row.map(value)),
  };
}

function options(python: Options) {
  return {
    aggregationLevel: python.aggregation_level,
    format: python.format,
    includeModelRevision: python.include_model_revision,
  };
}

const INDEX_COLUMNS = new Set([
  'task_name',
  'split',
  'subset',
  'is_public',
  'language',
]);

// The columns and rows of one experiment of a table with experiments, with
// the experiment level or column taken out: wide, the columns whose last
// level is the experiment, and the rows with a score in them; long, the rows
// of the experiment.
function experimentOf(table: DataFrame, experiment: string): Table {
  const level = (label: ColumnLabel): readonly Cell[] =>
    typeof label === 'object' && label !== null ? label : [label];
  const withoutLast = (label: ColumnLabel): ColumnLabel => {
    const rest = level(label).slice(0, -1);
    return rest.length === 1 ? (rest[0] ?? null) : rest;
  };
  if (table.columns.includes('experiment')) {
    const at = table.columns.indexOf('experiment');
    return plain({
      columns: table.columns.filter((_, index) => index !== at),
      rows: table.rows
        .filter((row) => row[at] === experiment)
        .map((row) => row.filter((_, index) => index !== at)),
    });
  }
  const kept = table.columns.flatMap((label, index) => {
    const levels = level(label);
    return INDEX_COLUMNS.has(String(levels[0])) || levels.at(-1) === experiment
      ? [index]
      : [];
  });
  const scores = kept.filter(
    (index) => !INDEX_COLUMNS.has(String(level(table.columns[index] ?? '')[0])),
  );
  return plain({
    columns: kept.map((index) => withoutLast(table.columns[index] ?? '')),
    rows: table.rows
      .filter((row) => scores.some((index) => !Number.isNaN(row[index] ?? NaN)))
      .map((row) => kept.map((index) => row[index] ?? null)),
  });
}

function load(loadExperiments: 'match_name' | 'no_experiments' = 'match_name') {
  return new ResultCache(FOLDER).loadResults({
    includeRemote: false,
    loadExperiments,
  });
}

// assert.deepEqual compares numbers with Object.is: NaN equals NaN, and
// 0.1 differs from 0.09999999999999999.
test('each table of each model result equals the table of MTEB, to the last bit', () => {
  const results = load();

  for (const { model, options: python, table } of expected.model_results) {
    const [name, revision, experiment] = model;
    const result = results.modelResults.find(
      (candidate) =>
        candidate.modelName === name &&
        candidate.modelRevision === revision &&
        candidate.experimentName === experiment,
    );
    assert.ok(result, `${model.join(' ')} is loaded`);
    assert.deepEqual(
      plain(result.toDataFrame(options(python))),
      plain(table),
      `${model.join(' ')} ${JSON.stringify(python)}`,
    );
  }
  assert.equal(expected.model_results.length, results.modelResults.length * 16);
});

test('each table of the benchmark results equals the table of MTEB, to the last bit', () => {
  const results = load();

  for (const { options: python, table } of expected.benchmark_results)
    assert.deepEqual(
      plain(results.toDataFrame(options(python))),
      plain(table),
      JSON.stringify(python),
    );
});

test('a custom aggregation gets the scores of each cell, NaN included, as np.max does', () => {
  const results = load();
  const maximum = (scores: readonly number[]) => {
    const numbers = scores.filter((score) => !Number.isNaN(score));
    return numbers.length === 0 ? NaN : Math.max(...numbers);
  };

  for (const { options: python, table } of expected.maximum)
    assert.deepEqual(
      plain(
        results.toDataFrame({ ...options(python), aggregationFn: maximum }),
      ),
      plain(table),
      JSON.stringify(python),
    );
});

test('results without scores give an empty table, as in MTEB', () => {
  const results = load().selectModels([]);

  assert.deepEqual(plain(results.toDataFrame()), plain(expected.empty));
});

test('the aggregated scores equal those of MTEB, over task types, and a NaN score gives null', () => {
  const task = (
    name: string,
    type: TaskType,
    evalSplits: string[],
    hfSubsets: string[],
  ): ResultTask => ({
    metadata: {
      name,
      revision: 'fixture',
      hfSubsetsToLangscripts: new Map(),
      domains: null,
      modalities: ['text'],
      type,
      isPublic: true,
    },
    evalSplits,
    hfSubsets,
    isAggregate: false,
  });
  // The task types that MTEB finds in its registry.
  const tasks = [
    task('ArguAna', 'Retrieval', ['test'], ['default']),
    task('SCIDOCS', 'Retrieval', ['test'], ['default']),
    task(
      'AmazonCounterfactualClassification',
      'Classification',
      ['validation', 'test', 'train'],
      ['en', 'de', 'ja', 'en-ext'],
    ),
  ];

  for (const [loadExperiments, byModel] of expected.aggregated) {
    const results = load(loadExperiments)
      .selectModels(['zukhruf/model-a', 'zukhruf/model-b'])
      .selectTasks(tasks);

    const scores = results.getAggregatedScores();

    assert.deepEqual(
      Object.entries(scores).map(([model, means]) => [
        model,
        Object.entries(means),
      ]),
      byModel.map(([model, means]) => [
        model,
        means.map(([key, mean]) => [
          key,
          typeof mean === 'string' ? Number(mean) : mean,
        ]),
      ]),
      loadExperiments,
    );
  }
});

test('with includeExperiments, each experiment of each model result keeps the table of MTEB under its experiment', () => {
  const results = load();

  for (const { model, options: python, table } of expected.model_results) {
    const [name, revision, experiment] = model;
    const result = results.modelResults.find(
      (candidate) =>
        candidate.modelName === name &&
        candidate.modelRevision === revision &&
        candidate.experimentName === experiment,
    );
    assert.ok(result, `${model.join(' ')} is loaded`);
    assert.deepEqual(
      experimentOf(
        result.toDataFrame({ ...options(python), includeExperiments: true }),
        experiment ?? '',
      ),
      plain(table),
      `${model.join(' ')} ${JSON.stringify(python)}`,
    );
  }
});

test('with includeExperiments, each experiment of the benchmark results equals the table of MTEB of that experiment alone, to the last bit', () => {
  const results = load();

  for (const {
    experiment,
    options: python,
    table,
  } of expected.experiment_tables)
    assert.deepEqual(
      experimentOf(
        results.toDataFrame({ ...options(python), includeExperiments: true }),
        experiment,
      ),
      plain(table),
      `${experiment} ${JSON.stringify(python)}`,
    );
  assert.deepEqual(
    [...new Set(expected.experiment_tables.map((entry) => entry.experiment))],
    ['', 'k1_1.2'],
  );
});

test('with includeExperiments, the aggregated scores of each experiment equal those of MTEB for that experiment alone', () => {
  const tasks: ResultTask[] = [
    ['ArguAna', 'Retrieval', ['test'], ['default']] as const,
    ['SCIDOCS', 'Retrieval', ['test'], ['default']] as const,
    [
      'AmazonCounterfactualClassification',
      'Classification',
      ['validation', 'test', 'train'],
      ['en', 'de', 'ja', 'en-ext'],
    ] as const,
  ].map(([name, type, evalSplits, hfSubsets]) => ({
    metadata: {
      name,
      revision: 'fixture',
      hfSubsetsToLangscripts: new Map(),
      domains: null,
      modalities: ['text'],
      type,
      isPublic: true,
    },
    evalSplits: [...evalSplits],
    hfSubsets: [...hfSubsets],
    isAggregate: false,
  }));

  for (const [
    loadExperiments,
    byExperiment,
  ] of expected.experiment_aggregated) {
    const scores = load(loadExperiments)
      .selectModels(['zukhruf/model-a', 'zukhruf/model-b'])
      .selectTasks(tasks)
      .getAggregatedScores({ includeExperiments: true });

    for (const [experiment, byModel] of byExperiment)
      assert.deepEqual(
        Object.entries(scores).flatMap(([model, experiments]) => {
          const means = experiments[experiment];
          return means === undefined ? [] : [[model, Object.entries(means)]];
        }),
        byModel.map(([model, means]) => [
          model,
          means.map(([key, mean]) => [
            key,
            typeof mean === 'string' ? Number(mean) : mean,
          ]),
        ]),
        `${loadExperiments} ${experiment}`,
      );
  }
});
