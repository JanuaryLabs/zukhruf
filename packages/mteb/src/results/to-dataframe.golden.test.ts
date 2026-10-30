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
