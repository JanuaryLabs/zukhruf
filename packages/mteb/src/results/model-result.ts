// mteb/results/model_result.py. MTEB also pushes results to the HuggingFace
// Hub and filters them by model registry facts; this port does not.
import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import {
  type AggregationFn,
  type Cell,
  type ColumnLabel,
  DataFrame,
  Frame,
  uniqueKeys,
} from '../dependencies/pandas.ts';
import { ModelMeta } from '../models/model-meta.ts';
import type { Modalities, ScoresDict } from '../types/index.ts';
import { pydanticJsonDumps, pythonJsonLoads } from './json.ts';
import {
  type ResultTask,
  type TaskError,
  TaskResult,
  type TaskResultDict,
  taskErrorSchema,
} from './task-result.ts';

export type ModelResultInit = {
  readonly modelName: string;
  readonly modelRevision: string | null;
  readonly taskResults: readonly TaskResult[];
  readonly exceptions?: readonly TaskError[] | null;
  readonly experimentName?: string | null;
  readonly modelMeta?: ModelMeta | null;
};

// A ModelResult as a dict: the keys of its JSON form.
export type ModelResultDict = {
  readonly model_name: string;
  readonly model_revision: string | null;
  readonly task_results: readonly TaskResultDict[];
  readonly exceptions:
    | readonly {
        readonly task_name: string;
        readonly exception: string;
      }[]
    | null;
  readonly experiment_name: string | null;
  readonly model_meta: Record<string, unknown> | null;
};

const modelResultSchema = z.object({
  model_name: z.string(),
  model_revision: z.string().nullable(),
  task_results: z.array(z.unknown()),
  exceptions: z.array(taskErrorSchema).nullable().default(null),
  experiment_name: z.string().nullable().default(null),
  model_meta: z.record(z.string(), z.unknown()).nullable().default(null),
});

// The level that a table aggregates the scores to: a row for each subset,
// split, task or language.
export type AggregationLevel = 'subset' | 'split' | 'task' | 'language';

export type ToDataFrameOptions = {
  readonly aggregationLevel?: AggregationLevel;
  // The aggregation of the scores of a cell; by default pandas' mean, which
  // skips NaN.
  readonly aggregationFn?: AggregationFn;
  // A column for each model and revision, in place of each model.
  readonly includeModelRevision?: boolean;
  // A column for each experiment of a model (wide: a column level
  // "experiment" under the model; long: an "experiment" column), in place of
  // one column that averages the experiments with the default run, as MTEB
  // does. The default run is the experiment "". Not in MTEB.
  readonly includeExperiments?: boolean;
  // wide: a column for each model; long: a row for each model and a score
  // column.
  readonly format?: 'wide' | 'long';
  // The scores to table, in place of the main score, side by side in this
  // order (wide: a column level of the score above the model; long: a column
  // for each score, named by it, in place of "score"). Each score has the
  // table that MTEB makes when it is the main score. Not in MTEB.
  readonly scores?: readonly [string, ...string[]];
};

// The table of the main score, or of each score of options.scores side by
// side. frameOf gives the frame of the rows with a score column for a score
// name, or null when there are no scores.
export function toTable(
  frameOf: (score: string) => Frame | null,
  columns: readonly string[],
  options: ToDataFrameOptions,
): DataFrame {
  const aggregationLevel = options.aggregationLevel ?? 'task';
  const outputFormat = options.format ?? 'wide';
  const tables: [string, DataFrame][] = [];
  let width = 0;
  for (const score of options.scores ?? ['main_score']) {
    const frame = frameOf(score);
    if (frame === null) return new DataFrame();
    const at = frame.columns.indexOf('score');
    if (
      options.scores !== undefined &&
      frame.rows.every((row) => row[at] === null)
    )
      throw new RangeError(`No result has the score ${score}.`);
    width = indexColumnsOf(aggregationLevel, frame).length;
    tables.push([
      score,
      aggregateAndPivot(
        frame,
        columns,
        aggregationLevel,
        outputFormat,
        options.aggregationFn,
      ),
    ]);
  }
  if (options.scores === undefined) return tables[0]?.[1] ?? new DataFrame();
  return outputFormat === 'long'
    ? sideBySideLong(tables)
    : sideBySideWide(tables, width);
}

// Long tables of the same rows: their key columns, then the score column of
// each table, named by its score. The keys of a row do not depend on the
// score, so each table has the same rows in the same order.
function sideBySideLong(tables: readonly [string, DataFrame][]): DataFrame {
  const first = tables[0]?.[1] ?? new DataFrame();
  return new DataFrame(
    [...first.columns.slice(0, -1), ...tables.map(([score]) => score)],
    first.rows.map((row, index) => [
      ...row.slice(0, -1),
      ...tables.map(([, table]) => table.rows[index]?.at(-1) ?? NaN),
    ]),
  );
}

// Wide tables side by side: the rows of all tables, in the order of the
// index columns (the first width columns), and the columns of each table
// under a column level of its score. A row that one table does not have is
// NaN there: pivot_table drops a group whose aggregate is NaN, so the tables
// of two scores can have different rows.
function sideBySideWide(
  tables: readonly [string, DataFrame][],
  width: number,
): DataFrame {
  const levels = (label: ColumnLabel): readonly Cell[] =>
    typeof label === 'object' && label !== null ? label : [label];
  const keyOf = (row: readonly Cell[]) => JSON.stringify(row.slice(0, width));
  const first = tables[0]?.[1] ?? new DataFrame();
  const byKey = tables.map(
    ([, table]) => new Map(table.rows.map((row) => [keyOf(row), row])),
  );
  return new DataFrame(
    [
      ...first.columns.slice(0, width).map((label) => [...levels(label), '']),
      ...tables.flatMap(([score, table]) =>
        table.columns.slice(width).map((label) => [score, ...levels(label)]),
      ),
    ],
    uniqueKeys(
      tables.flatMap(([, table]) =>
        table.rows.map((row) => row.slice(0, width)),
      ),
    ).map((key) => [
      ...key,
      ...tables.flatMap(([, table], index) => {
        const row = byKey[index]?.get(JSON.stringify(key));
        return table.columns
          .slice(width)
          .map((_, column) => row?.[width + column] ?? NaN);
      }),
    ]),
  );
}

// The index columns of a table at an aggregation level: the rows of a wide
// table, and the last keys of a long one.
function indexColumnsOf(
  aggregationLevel: AggregationLevel,
  frame: Frame,
): string[] {
  switch (aggregationLevel) {
    case 'subset':
      return ['task_name', 'split', 'subset'];
    case 'split':
      return ['task_name', 'split'];
    case 'task':
      return frame.columns.includes('is_public')
        ? ['task_name', 'is_public']
        : ['task_name'];
    case 'language':
      return ['language'];
  }
}

// _aggregate_and_pivot.
function aggregateAndPivot(
  frame: Frame,
  columns: readonly string[],
  aggregationLevel: AggregationLevel,
  outputFormat: 'wide' | 'long',
  aggregationFn: AggregationFn | undefined,
): DataFrame {
  const indexColumns = indexColumnsOf(aggregationLevel, frame);
  const df =
    aggregationLevel === 'language' ? frame.explode('language') : frame;
  if (outputFormat === 'wide')
    return df.pivotTable({
      index: indexColumns,
      columns,
      values: 'score',
      aggfunc: aggregationFn,
    });
  return df.groupbyAgg({
    keys: [...columns, ...indexColumns],
    values: 'score',
    name: 'score',
    aggfunc: aggregationFn,
  });
}

// The results of one model, at one revision, on a set of tasks.
export class ModelResult implements Iterable<TaskResult> {
  readonly modelName: string;
  readonly modelRevision: string | null;
  readonly taskResults: readonly TaskResult[];
  // The tasks whose evaluation failed.
  readonly exceptions: readonly TaskError[] | null;
  readonly experimentName: string | null;
  readonly modelMeta: ModelMeta | null;

  constructor(init: ModelResultInit) {
    this.modelName = init.modelName;
    this.modelRevision = init.modelRevision;
    this.taskResults = init.taskResults;
    this.exceptions = init.exceptions ?? null;
    this.experimentName = init.experimentName ?? null;
    this.modelMeta = init.modelMeta ?? null;
  }

  // From the dict form of results that are known to be valid.
  static fromValidated(data: ModelResultDict): ModelResult {
    return new ModelResult({
      modelName: data.model_name,
      modelRevision: data.model_revision,
      taskResults: data.task_results.map((result) =>
        TaskResult.fromValidated({
          datasetRevision: result.dataset_revision,
          taskName: result.task_name,
          mtebVersion: result.mteb_version,
          scores: result.scores,
          evaluationTime: result.evaluation_time,
          kgCo2Emissions: result.kg_co2_emissions,
          date: result.date,
          evaluationPhases: result.evaluation_phases,
        }),
      ),
      exceptions:
        data.exceptions?.map((error) => ({
          taskName: error.task_name,
          exception: error.exception,
        })) ?? null,
      experimentName: data.experiment_name,
      modelMeta:
        data.model_meta === null ? null : ModelMeta.fromDict(data.model_meta),
    });
  }

  // model_validate of the dict form.
  static fromDict(data: unknown): ModelResult {
    const parsed = modelResultSchema.parse(data);
    return new ModelResult({
      modelName: parsed.model_name,
      modelRevision: parsed.model_revision,
      taskResults: parsed.task_results.map((result) =>
        TaskResult.fromDict(result),
      ),
      exceptions: parsed.exceptions,
      experimentName: parsed.experiment_name,
      modelMeta:
        parsed.model_meta === null
          ? null
          : ModelMeta.fromDict(parsed.model_meta),
    });
  }

  // model_dump.
  toDict(): ModelResultDict {
    return {
      model_name: this.modelName,
      model_revision: this.modelRevision,
      task_results: this.taskResults.map((result) => result.toDict()),
      exceptions:
        this.exceptions?.map((error) => ({
          task_name: error.taskName,
          exception: error.exception,
        })) ?? null,
      experiment_name: this.experimentName,
      model_meta: this.modelMeta?.toDict() ?? null,
    };
  }

  // Writes the results as pydantic's model_dump_json(indent=2).
  toDisk(path: string): void {
    writeFileSync(path, pydanticJsonDumps(this.toDict()));
  }

  static fromDisk(path: string): ModelResult {
    return ModelResult.fromDict(pythonJsonLoads(readFileSync(path, 'utf8')));
  }

  // The results of the given tasks, each validated against its task.
  selectTasks(tasks: Iterable<ResultTask>): ModelResult {
    const byName = new Map(
      [...tasks].map((task) => [task.metadata.name, task]),
    );
    return new ModelResult({
      modelName: this.modelName,
      modelRevision: this.modelRevision,
      taskResults: this.taskResults.flatMap((result) => {
        const task = byName.get(result.taskName);
        return task === undefined ? [] : [result.validateAndFilterScores(task)];
      }),
      experimentName: this.experimentName,
      modelMeta: this.modelMeta,
    });
  }

  // A table of the scores: a row for each task (or subset, split or
  // language) and a column for the model, or a row for each score with the
  // long format. Without scores, an empty table.
  toDataFrame(options: ToDataFrameOptions = {}): DataFrame {
    const columns = ['model_name'];
    if (options.includeModelRevision) columns.push('model_revision');
    if (options.includeExperiments) columns.push('experiment');
    return toTable(
      (score) => {
        const rows = this.#getScoreForTable(score);
        if (rows.length === 0) return null;
        return Frame.fromColumns({
          model_name: rows.map((row) => row.modelName),
          model_revision: rows.map((row) => row.modelRevision),
          task_name: rows.map((row) => row.taskName),
          split: rows.map((row) => row.split),
          language: rows.map((row) => row.language),
          experiment: rows.map(() => this.experimentName ?? ''),
          subset: rows.map((row) => row.subset),
          score: rows.map((row) => row.score),
        }).drop([
          ...(options.includeModelRevision ? [] : ['model_revision']),
          ...(options.includeExperiments ? [] : ['experiment']),
        ]);
      },
      columns,
      options,
    );
  }

  #getScoreForTable(score: string): TableRow[] {
    return this.taskResults.flatMap((taskResult) =>
      Object.entries(taskResult.scores).flatMap(([split, scoresList]) =>
        scoresList.map((scores) =>
          tableRow(
            this.modelName,
            this.modelRevision,
            taskResult.taskName,
            split,
            scores,
            score,
          ),
        ),
      ),
    );
  }

  [Symbol.iterator](): Iterator<TaskResult> {
    return this.taskResults[Symbol.iterator]();
  }

  get length(): number {
    return this.taskResults.length;
  }

  get languages(): string[] {
    return unique(this.taskResults.flatMap((result) => result.languages));
  }

  get domains(): string[] {
    return unique(this.taskResults.flatMap((result) => [...result.domains]));
  }

  get taskTypes(): string[] {
    return unique(this.taskResults.map((result) => result.taskType));
  }

  get taskNames(): string[] {
    return this.taskResults.map((result) => result.taskName);
  }

  // The modalities of the tasks, or text when there is no task.
  get modalities(): Modalities[] {
    const modalities = this.taskResults.flatMap((result) => [
      ...result.modalities,
    ]);
    return modalities.length === 0 ? ['text'] : unique(modalities);
  }
}

// A score of a subset before the aggregation.
export type TableRow = {
  readonly modelName: string;
  readonly modelRevision: string | null;
  readonly taskName: string;
  readonly split: string;
  readonly language: readonly string[];
  readonly subset: string;
  readonly score: number | null;
};

// The row of a scores dict: score_item.get("languages", ["Unknown"]),
// .get("hf_subset", "default") and .get(score, None). MTEB reads the score
// "main_score" only.
export function tableRow(
  modelName: string,
  modelRevision: string | null,
  taskName: string,
  split: string,
  scores: ScoresDict,
  scoreName: string,
): TableRow {
  const rawLanguages = scores['languages'];
  let language: string[];
  if (rawLanguages === undefined) language = ['Unknown'];
  else if (Array.isArray(rawLanguages)) language = rawLanguages.map(String);
  else language = [];
  const subset = scores['hf_subset'];
  const score = scores[scoreName];
  return {
    modelName,
    modelRevision,
    taskName,
    split,
    language,
    subset: subset === undefined ? 'default' : String(subset),
    score: typeof score === 'number' ? score : null,
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
