// mteb/results/benchmark_results.py. MTEB also builds pandas and polars data
// frames, aggregates scores, keeps the leaderboard cache and filters models
// by its model registry; this port does not.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import { Version } from '../dependencies/packaging.ts';
import { compareStrings } from '../dependencies/python.ts';
import type { ModelMeta } from '../models/model-meta.ts';
import { pydanticJsonDumps, pythonJsonLoads } from './json.ts';
import { ModelResult, type ModelResultDict } from './model-result.ts';
import type { ResultTask, TaskResult } from './task-result.ts';

const benchmarkResultsSchema = z.object({
  model_results: z.array(z.unknown()),
});

// The results of several models.
export class BenchmarkResults implements Iterable<ModelResult> {
  readonly modelResults: readonly ModelResult[];

  constructor(modelResults: readonly ModelResult[]) {
    this.modelResults = modelResults;
  }

  // The results of the given tasks, each validated against its task.
  selectTasks(tasks: Iterable<ResultTask>): BenchmarkResults {
    const list = [...tasks];
    return new BenchmarkResults(
      this.modelResults.map((result) => result.selectTasks(list)),
    );
  }

  // The results of the models with the given names, and the given
  // revisions. A ModelMeta names its revision; a null revision takes all.
  selectModels(
    names: readonly (string | ModelMeta)[],
    revisions?: readonly (string | null)[],
  ): BenchmarkResults {
    const wanted = revisions ?? names.map(() => null);
    if (names.length !== wanted.length)
      throw new Error(
        'The length of names and revisions must be the same or revisions must be None.',
      );
    const nameToRevision = new Map<string, string | null>();
    for (const [index, name] of names.entries()) {
      if (typeof name === 'string') {
        nameToRevision.set(name, wanted[index] ?? null);
        continue;
      }
      if (name.name === null)
        throw new Error('name in ModelMeta is None. It must be a string.');
      nameToRevision.set(name.name, name.revision);
    }
    return new BenchmarkResults(
      this.modelResults.filter((result) => {
        if (!nameToRevision.has(result.modelName)) return false;
        const revision = nameToRevision.get(result.modelName) ?? null;
        return revision === null || result.modelRevision === revision;
      }),
    );
  }

  // One result for each model, experiment and task, over all revisions: the
  // result of the main revision of the model, else of the latest MTEB
  // version, else of a known revision. MTEB finds the main revision in its
  // model registry; this package has none, so no revision is the main one.
  joinRevisions(): BenchmarkResults {
    const rows = this.modelResults
      .flatMap((modelResult) =>
        modelResult.taskResults.map((taskResult) => ({
          model: modelResult.modelName,
          revision: modelResult.modelRevision,
          experimentName: modelResult.experimentName ?? '',
          taskName: taskResult.taskName,
          mtebVersion:
            taskResult.mtebVersion === null
              ? null
              : Version.tryParse(taskResult.mtebVersion),
          taskResult,
          modelMeta: modelResult.modelMeta,
          hasScores: Object.keys(taskResult.scores).length > 0,
        })),
      )
      .filter((row) => row.hasScores)
      .map((row) => {
        const known = row.revision !== null && row.revision !== 'external';
        return {
          ...row,
          priority: (row.mtebVersion === null ? 0 : 100) + (known ? 10 : 0),
        };
      });
    // pandas sort_values over several columns is stable.
    rows.sort(
      (left, right) =>
        compareStrings(left.model, right.model) ||
        compareStrings(left.experimentName, right.experimentName) ||
        compareStrings(left.taskName, right.taskName) ||
        right.priority - left.priority ||
        compareVersionsDescending(left.mtebVersion, right.mtebVersion),
    );
    // groupby(...).first() takes the first non-null value of each column.
    const firsts = new Map<string, JoinedRow>();
    for (const row of rows) {
      const key = JSON.stringify([row.model, row.experimentName, row.taskName]);
      const first = firsts.get(key);
      if (first === undefined)
        firsts.set(key, {
          model: row.model,
          experimentName: row.experimentName,
          revision: row.revision,
          taskResult: row.taskResult,
          modelMeta: row.modelMeta,
        });
      else {
        first.revision ??= row.revision;
        first.modelMeta ??= row.modelMeta;
      }
    }
    // groupby(["model", "revision", "experiment_name"]) sorts its keys and
    // drops the rows whose revision is null.
    const groups = new Map<string, JoinedRow[]>();
    for (const first of firsts.values()) {
      if (first.revision === null) continue;
      const key = JSON.stringify([
        first.model,
        first.revision,
        first.experimentName,
      ]);
      groups.set(key, [...(groups.get(key) ?? []), first]);
    }
    const ordered = [...groups.values()].sort((left, right) => {
      const [a] = left;
      const [b] = right;
      if (a === undefined || b === undefined) return 0;
      return (
        compareStrings(a.model, b.model) ||
        compareStrings(a.revision ?? '', b.revision ?? '') ||
        compareStrings(a.experimentName, b.experimentName)
      );
    });
    return new BenchmarkResults(
      ordered.flatMap((group) => {
        const [head] = group;
        if (head === undefined) return [];
        return [
          new ModelResult({
            modelName: head.model,
            modelRevision: head.revision,
            taskResults: group.map((row) => row.taskResult),
            experimentName: head.experimentName || null,
            modelMeta: head.modelMeta,
          }),
        ];
      }),
    );
  }

  [Symbol.iterator](): Iterator<ModelResult> {
    return this.modelResults[Symbol.iterator]();
  }

  get languages(): string[] {
    return unique(this.modelResults.flatMap((result) => result.languages));
  }

  get domains(): string[] {
    return unique(this.modelResults.flatMap((result) => result.domains));
  }

  get taskTypes(): string[] {
    return unique(this.modelResults.flatMap((result) => result.taskTypes));
  }

  get taskNames(): string[] {
    return unique(this.modelResults.flatMap((result) => result.taskNames));
  }

  get modalities(): string[] {
    return unique(this.modelResults.flatMap((result) => result.modalities));
  }

  get modelNames(): string[] {
    return this.modelResults.map((result) => result.modelName);
  }

  get modelRevisions(): { modelName: string; revision: string | null }[] {
    return this.modelResults.map((result) => ({
      modelName: result.modelName,
      revision: result.modelRevision,
    }));
  }

  // model_dump. MTEB's benchmark field is always null here.
  toDict(): {
    readonly model_results: readonly ModelResultDict[];
    readonly benchmark: null;
  } {
    return {
      model_results: this.modelResults.map((result) => result.toDict()),
      benchmark: null,
    };
  }

  static fromDict(data: unknown): BenchmarkResults {
    const parsed = benchmarkResultsSchema.parse(data);
    return new BenchmarkResults(
      parsed.model_results.map((result) => ModelResult.fromDict(result)),
    );
  }

  static fromValidated(data: {
    readonly model_results: readonly ModelResultDict[];
  }): BenchmarkResults {
    return new BenchmarkResults(
      data.model_results.map((result) => ModelResult.fromValidated(result)),
    );
  }

  // Writes the results as pydantic's model_dump_json(indent=2).
  toDisk(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pydanticJsonDumps(this.toDict()));
  }

  static fromDisk(path: string): BenchmarkResults {
    return BenchmarkResults.fromDict(
      pythonJsonLoads(readFileSync(path, 'utf8')),
    );
  }
}

// The result that joinRevisions keeps for a model, experiment and task.
type JoinedRow = {
  readonly model: string;
  readonly experimentName: string;
  revision: string | null;
  readonly taskResult: TaskResult;
  modelMeta: ModelMeta | null;
};

// mteb_version descending, with null last.
function compareVersionsDescending(
  left: Version | null,
  right: Version | null,
): number {
  if (left === null || right === null)
    return left === right ? 0 : left === null ? 1 : -1;
  return right.compare(left);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
