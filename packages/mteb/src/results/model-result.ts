// mteb/results/model_result.py. MTEB also turns results into pandas data
// frames, pushes them to the HuggingFace Hub and filters them by model
// registry facts; this port does not.
import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import { ModelMeta } from '../models/model-meta.ts';
import type { Modalities } from '../types/index.ts';
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

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
