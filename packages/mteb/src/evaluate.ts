import type { AbsTask, MTEBModels } from './abstasks/abstask.ts';
import { AbsTaskRetrieval } from './abstasks/retrieval.ts';
import { ResultCache } from './cache/result-cache.ts';
import {
  type ModelMeta,
  mergePrecisionIntoExperimentKwargs,
} from './models/model-meta.ts';
import { ModelResult } from './results/model-result.ts';
import { type TaskError, TaskResult } from './results/task-result.ts';
import { TimingStack, monotonic } from './timing.ts';
import type { EncodeKwargs } from './types/encoder-io.ts';
import type { HFSubset, ScoresDict, SplitName } from './types/result.ts';

// mteb/evaluate.py. Not ported: aggregated tasks and benchmarks, bitext
// mining's batches of subsets, loading a model from a ModelMeta, the CO₂
// tracker, and the private datasets of the HuggingFace Hub. MTEB's timer
// option is not ported either: the evaluation of a task makes its own.

// What evaluate does with the results that the cache already has.
// - always: run the task and replace the results.
// - never: run the task only when the cache has no results.
// - only-missing: run the splits and subsets that the cache lacks.
// - only-cache: only load the results of the cache.
export const OVERWRITE_STRATEGIES = [
  'always',
  'never',
  'only-missing',
  'only-cache',
] as const;

export type OverwriteStrategy = (typeof OVERWRITE_STRATEGIES)[number];

export type EvaluateOptions = {
  readonly encodeKwargs?: EncodeKwargs;
  // Throw the error of a task; otherwise the result lists it.
  readonly raiseError?: boolean;
  // null: no cache. The default keeps results in ~/.cache/mteb.
  readonly cache?: ResultCache | null;
  readonly overwriteStrategy?: OverwriteStrategy;
  // The folder that keeps <task name>_predictions.json for each task.
  readonly predictionFolder?: string | null;
};

type Splits = ReadonlyMap<SplitName, readonly HFSubset[]>;

// Runs a model on tasks and gives the results of each task.
export async function evaluate(
  model: MTEBModels,
  tasks: AbsTask | Iterable<AbsTask>,
  options: EvaluateOptions = {},
): Promise<ModelResult> {
  const kwargs: EncodeKwargs = { batchSize: 32, ...options.encodeKwargs };
  const meta = applyPrecisionToMeta(model.mtebModelMeta, kwargs);
  checkModelModalities(meta, tasks);
  const overwriteStrategy = options.overwriteStrategy ?? 'only-missing';
  if (!OVERWRITE_STRATEGIES.includes(overwriteStrategy))
    throw new Error(
      `'${String(overwriteStrategy)}' is not a valid OverwriteStrategy. Valid values are: ${OVERWRITE_STRATEGIES.join(', ')}`,
    );
  return evaluateResolved(model, meta, tasks, {
    raiseError: options.raiseError ?? true,
    encodeKwargs: kwargs,
    cache: options.cache === undefined ? new ResultCache() : options.cache,
    overwriteStrategy,
    predictionFolder: options.predictionFolder ?? null,
  });
}

type Resolved = {
  readonly raiseError: boolean;
  readonly encodeKwargs: EncodeKwargs;
  readonly cache: ResultCache | null;
  readonly overwriteStrategy: OverwriteStrategy;
  readonly predictionFolder: string | null;
};

async function evaluateResolved(
  model: MTEBModels,
  meta: ModelMeta,
  tasks: AbsTask | Iterable<AbsTask>,
  options: Resolved,
): Promise<ModelResult> {
  const modelName = meta.name ?? 'no_model_name/available';
  const modelRevision = meta.revision ?? 'no_revision_available';
  if (!isTask(tasks)) {
    const taskResults: TaskResult[] = [];
    const exceptions: TaskError[] = [];
    for (const task of tasks) {
      const result = await evaluateResolved(model, meta, task, options);
      taskResults.push(...result.taskResults);
      exceptions.push(...(result.exceptions ?? []));
    }
    return new ModelResult({
      modelName,
      modelRevision,
      taskResults,
      exceptions,
    });
  }
  const task = tasks;
  const [existing, missing] = checkCache(
    task,
    meta,
    options.cache,
    options.overwriteStrategy,
  );
  if (
    existing !== null &&
    missing.size === 0 &&
    options.overwriteStrategy !== 'always'
  )
    return new ModelResult({
      modelName,
      modelRevision,
      taskResults: [existing],
    });
  let result: TaskResult | TaskError;
  const run = () =>
    evaluateTask(model, task, {
      splits: missing,
      encodeKwargs: options.encodeKwargs,
      predictionFolder: options.predictionFolder,
      cache: options.cache,
      existingResults: existing,
      modelMeta: meta,
    });
  if (options.raiseError) result = await run();
  else
    try {
      result = await run();
    } catch (error) {
      result = {
        taskName: task.metadata.name,
        exception: error instanceof Error ? error.message : String(error),
      };
    }
  if (!(result instanceof TaskResult))
    return new ModelResult({
      modelName,
      modelRevision,
      taskResults: [],
      exceptions: [result],
    });
  options.cache?.saveToCache(result, meta, {
    encodeKwargs: options.encodeKwargs,
  });
  return new ModelResult({ modelName, modelRevision, taskResults: [result] });
}

function isTask(tasks: AbsTask | Iterable<AbsTask>): tasks is AbsTask {
  return !(Symbol.iterator in tasks);
}

// The core of evaluate on one task: each subset of each missing split.
async function evaluateTask(
  model: MTEBModels,
  task: AbsTask,
  options: {
    readonly splits: Splits;
    readonly encodeKwargs: EncodeKwargs;
    readonly predictionFolder: string | null;
    readonly cache: ResultCache | null;
    readonly existingResults: TaskResult | null;
    readonly modelMeta: ModelMeta;
  },
): Promise<TaskResult> {
  const taskResults = new Map<SplitName, Map<HFSubset, ScoresDict>>();
  let evaluationTime = 0;
  const existing = options.existingResults;
  const existingCo2 = existing?.kgCo2Emissions ?? null;
  if (existing !== null) {
    for (const [split, scores] of Object.entries(existing.scores))
      taskResults.set(
        split,
        new Map(scores.map((score) => [String(score.hf_subset), score])),
      );
    if (existing.evaluationTime !== null)
      evaluationTime = existing.evaluationTime;
  }
  const timer = new TimingStack();
  const preloaded = task.dataLoaded;
  if (!preloaded) {
    const phasesBefore = timer.phases.length;
    const start = monotonic();
    await task.loadData({ timer });
    const end = monotonic();
    evaluationTime += end - start;
    if (timer.phases.length === phasesBefore)
      timer.addPhase('Data loading', { start, end, split: '', subset: '' });
  }
  for (const [split, subsets] of options.splits) {
    const tick = monotonic();
    const splitResults = taskResults.get(split) ?? new Map();
    taskResults.set(split, splitResults);
    const phasesBefore = timer.phases.length;
    const start = monotonic();
    for (const subset of subsets) {
      const scores = await task.evaluate(model, split, [subset], {
        encodeKwargs: options.encodeKwargs,
        predictionFolder: options.predictionFolder,
        timer,
      });
      const tock = monotonic();
      for (const [name, value] of scores) splitResults.set(name, value);
      if (options.cache !== null)
        options.cache.saveToCache(
          TaskResult.fromTaskResults(
            task,
            taskResults,
            evaluationTime + (tock - tick),
            {
              kgCo2Emissions: existingCo2,
              date: new Date(),
              evaluationPhases: timer.phases.length > 0 ? timer.phases : null,
            },
          ),
          options.modelMeta,
        );
    }
    const end = monotonic();
    // The phase of the whole split, for a task that records no phases.
    if (timer.phases.length === phasesBefore)
      timer.addPhase('Evaluation', { start, end, split, subset: '' });
    evaluationTime += end - start;
  }
  const result = TaskResult.fromTaskResults(task, taskResults, evaluationTime, {
    kgCo2Emissions: existingCo2,
    date: new Date(),
    evaluationPhases: timer.phases.length > 0 ? timer.phases : null,
  });
  if (!preloaded) task.unloadData();
  return result;
}

// encode's precision changes the dtype of the embeddings, so a run with it
// keeps its results apart from a float run.
function applyPrecisionToMeta(
  meta: ModelMeta,
  encodeKwargs: EncodeKwargs,
): ModelMeta {
  if (encodeKwargs.precision === undefined) return meta;
  const experimentKwargs = mergePrecisionIntoExperimentKwargs(
    meta.experimentKwargs,
    encodeKwargs,
  );
  if (
    experimentKwargs.output_dtypes ===
    (meta.experimentKwargs ?? {}).output_dtypes
  )
    return meta;
  return meta.modelCopy({ experimentKwargs });
}

// Throws when a task has a modality that the model does not support.
function checkModelModalities(
  model: ModelMeta,
  tasks: AbsTask | Iterable<AbsTask>,
): void {
  const supported = new Set<string>(model.modalities);
  if (supported.size === 0) return;
  const errors: string[] = [];
  for (const task of isTask(tasks) ? [tasks] : tasks) {
    if (task instanceof AbsTaskRetrieval) {
      const queryModalities = task.metadata.getModalities('query');
      const documentModalities = task.metadata.getModalities('document');
      const covered = (modalities: readonly string[]) =>
        modalities.every((modality) => supported.has(modality));
      const overlaps = (modalities: readonly string[]) =>
        modalities.some((modality) => supported.has(modality));
      if (covered(queryModalities) && covered(documentModalities)) continue;
      if (!overlaps(queryModalities) || !overlaps(documentModalities))
        errors.push(
          `Model ${model.name} supports [${[...supported].join(', ')}], but none overlap with task ${task.metadata.name} query=[${[...queryModalities].sort().join(', ')}], document=[${[...documentModalities].sort().join(', ')}].`,
        );
    } else if (
      !task.metadata.modalities.every((modality) => supported.has(modality))
    )
      errors.push(
        `Model ${model.name} supports [${[...supported].join(', ')}], but none overlap with task ${task.metadata.name} modalities=[${task.metadata.modalities.join(', ')}].`,
      );
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function requiresMerge(task: AbsTask, existing: TaskResult): boolean {
  for (const split of task.evalSplits) {
    const scores = existing.scores[split];
    if (scores === undefined) return true;
    const subsets = new Set(scores.map((score) => score.hf_subset));
    if (!task.hfSubsets.every((subset) => subsets.has(subset))) return true;
  }
  return false;
}

// The cached result to resume from, or null to run from scratch, and the
// subsets of each split that still need a run.
function checkCache(
  task: AbsTask,
  meta: ModelMeta,
  cache: ResultCache | null,
  overwriteStrategy: OverwriteStrategy,
): [TaskResult | null, Splits] {
  let existing: TaskResult | null = null;
  if (cache !== null && overwriteStrategy !== 'always')
    existing = cache.loadTaskResult(task.metadata.name, meta);
  const dontOverwrite =
    overwriteStrategy === 'never' || overwriteStrategy === 'only-cache';
  const mergeable =
    existing !== null &&
    (!requiresMerge(task, existing) || existing.isMergeable(task));
  let missing: Splits;
  if (existing !== null && (dontOverwrite || mergeable))
    missing = existing.getMissingEvaluations(task);
  else {
    missing = new Map(task.evalSplits.map((split) => [split, task.hfSubsets]));
    existing = null;
  }
  if (missing.size > 0 && dontOverwrite) {
    if (existing === null) {
      if (overwriteStrategy === 'only-cache')
        throw new Error(
          `overwrite_strategy is set to '${overwriteStrategy}' but no results found in cache for task ${task.metadata.name}.`,
        );
    } else
      throw new Error(
        `overwrite_strategy is set to '${overwriteStrategy}' and the results file exists for task ${task.metadata.name}. However there are the following missing splits (and subsets): ${JSON.stringify(Object.fromEntries(missing))}. To rerun these set overwrite_strategy to 'only-missing'.`,
      );
    existing = null;
  }
  return [existing, missing];
}
