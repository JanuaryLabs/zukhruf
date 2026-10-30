// mteb/results/model_result.py. MTEB also pushes results to the HuggingFace
// Hub and filters them by model registry facts; this port does not.
import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import {
  type AggregationFn,
  DataFrame,
  Frame,
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
};

// _aggregate_and_pivot.
export function aggregateAndPivot(
  frame: Frame,
  columns: readonly string[],
  aggregationLevel: AggregationLevel,
  outputFormat: 'wide' | 'long',
  aggregationFn: AggregationFn | undefined,
): DataFrame {
  let df = frame;
  let indexColumns: string[];
  switch (aggregationLevel) {
    case 'subset':
      indexColumns = ['task_name', 'split', 'subset'];
      break;
    case 'split':
      indexColumns = ['task_name', 'split'];
      break;
    case 'task':
      indexColumns = ['task_name'];
      if (df.columns.includes('is_public')) indexColumns.push('is_public');
      break;
    case 'language':
      indexColumns = ['language'];
      df = df.explode('language');
      break;
  }
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
    const rows = this.#getScoreForTable();
    if (rows.length === 0) return new DataFrame();
    let df = Frame.fromColumns({
      model_name: rows.map((row) => row.modelName),
      model_revision: rows.map((row) => row.modelRevision),
      task_name: rows.map((row) => row.taskName),
      split: rows.map((row) => row.split),
      language: rows.map((row) => row.language),
      experiment: rows.map(() => this.experimentName ?? ''),
      subset: rows.map((row) => row.subset),
      score: rows.map((row) => row.score),
    });
    const columns = ['model_name'];
    if (options.includeModelRevision) columns.push('model_revision');
    else df = df.drop(['model_revision']);
    if (options.includeExperiments) columns.push('experiment');
    else df = df.drop(['experiment']);
    return aggregateAndPivot(
      df,
      columns,
      options.aggregationLevel ?? 'task',
      options.format ?? 'wide',
      options.aggregationFn,
    );
  }

  #getScoreForTable(): TableRow[] {
    return this.taskResults.flatMap((taskResult) =>
      Object.entries(taskResult.scores).flatMap(([split, scoresList]) =>
        scoresList.map((scores) =>
          tableRow(
            this.modelName,
            this.modelRevision,
            taskResult.taskName,
            split,
            scores,
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
// .get("hf_subset", "default") and .get("main_score", None).
export function tableRow(
  modelName: string,
  modelRevision: string | null,
  taskName: string,
  split: string,
  scores: ScoresDict,
): TableRow {
  const rawLanguages = scores['languages'];
  let language: string[];
  if (rawLanguages === undefined) language = ['Unknown'];
  else if (Array.isArray(rawLanguages)) language = rawLanguages.map(String);
  else language = [];
  const subset = scores['hf_subset'];
  const score = scores['main_score'];
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
