// mteb/cache/result_cache.py, for the local folder. MTEB also downloads the
// result repository and the leaderboard cache from the HuggingFace Hub and
// submits results to it; this port does not. It reads a remote/ folder that
// is already in the cache.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { compareStrings, isPlainObject } from '../dependencies/python.ts';
import {
  ModelMeta,
  serializeExperimentKwargsToName,
} from '../models/model-meta.ts';
import { BenchmarkResults } from '../results/benchmark-results.ts';
import { pythonJsonDumps, pythonJsonLoads } from '../results/json.ts';
import { ModelResult } from '../results/model-result.ts';
import {
  MTEB_VERSION,
  type ResultTask,
  TaskResult,
  writeAndMergeKeyedJson,
} from '../results/task-result.ts';
import type { EncodeKwargs } from '../types/index.ts';

const EXPERIMENTS_FOLDER_NAME = 'experiments';

// Which experiments loadResults reads.
// - match_name: every result of the model name, experiments included. A
//   ModelMeta also matches its revision.
// - match_kwargs: the experiments whose keyword arguments match; assumes
//   ModelMetas are given.
// - no_experiments: only the results of models with default arguments.
export const LoadExperimentEnum = {
  MATCH_NAME: 'match_name',
  MATCH_KWARGS: 'match_kwargs',
  NO_EXPERIMENTS: 'no_experiments',
} as const;

export type LoadExperimentName =
  (typeof LoadExperimentEnum)[keyof typeof LoadExperimentEnum];

// A task result file in the results folder, with the folders it is in.
type ResultPath = {
  readonly path: string;
  // The folder of the model: its name with "/" as "__".
  readonly model: string;
  readonly revision: string;
  // The folder of the experiment, or null outside experiments/.
  readonly experiment: string | null;
};

// MTEB records the versions of its Python packages beside each result. This
// package has none of them but MTEB itself.
function packageVersions(): Record<string, string | null> {
  return {
    mteb: MTEB_VERSION,
    torch: null,
    'sentence-transformers': null,
    'flash-attn': null,
    transformers: null,
  };
}

// The local cache of results: results/<model>/<revision>/<task>.json, with
// model_meta.json and run_settings.jsonl in the revision folder, and
// results/<model>/<revision>/experiments/<name>/ for the experiments of a
// model.
export class ResultCache {
  readonly cachePath: string;

  constructor(cachePath?: string) {
    this.cachePath = cachePath ?? ResultCache.defaultCachePath;
    mkdirSync(this.cachePath, { recursive: true });
  }

  // ~/.cache/mteb. MTEB also reads the MTEB_CACHE environment variable.
  static get defaultCachePath(): string {
    return join(homedir(), '.cache', 'mteb');
  }

  // A clone of the remote result repository, when the cache has one.
  get remoteRepoPath(): string {
    return join(this.cachePath, 'remote');
  }

  get hasRemote(): boolean {
    return existsSync(this.remoteRepoPath);
  }

  get remoteResultsPath(): string {
    return join(this.remoteRepoPath, 'results');
  }

  // The path of the result of a task for a model. Without a revision, the
  // revision folder that changed last; a ModelMeta gives its revision and
  // experiment.
  getTaskResultPath(
    taskName: string,
    modelName: string | ModelMeta,
    options: {
      readonly modelRevision?: string | null;
      readonly remote?: boolean;
      readonly experimentName?: string | null;
    } = {},
  ): string {
    const resultsFolder = options.remote
      ? this.remoteResultsPath
      : join(this.cachePath, 'results');
    let revision = options.modelRevision ?? null;
    let experiment = options.experimentName ?? null;
    let folder: string;
    if (typeof modelName === 'string')
      folder = modelName.replaceAll('/', '__').replaceAll(' ', '_');
    else {
      revision = modelName.revision;
      experiment = modelName.experimentName;
      folder = modelName.modelNameAsPath();
    }
    const modelPath = join(resultsFolder, folder);
    revision ??= latestRevision(modelPath);
    return experiment
      ? join(
          modelPath,
          revision,
          EXPERIMENTS_FOLDER_NAME,
          experiment,
          `${taskName}.json`,
        )
      : join(modelPath, revision, `${taskName}.json`);
  }

  // The result of a task for a model, or null when the cache has none.
  loadTaskResult(
    taskName: string,
    modelName: string | ModelMeta,
    options: {
      readonly modelRevision?: string | null;
      readonly raiseIfNotFound?: boolean;
      readonly prioritizeRemote?: boolean;
      readonly experimentName?: string | null;
    } = {},
  ): TaskResult | null {
    const pathOptions = {
      modelRevision: options.modelRevision ?? null,
      experimentName: options.experimentName ?? null,
    };
    let resultPath = this.getTaskResultPath(taskName, modelName, pathOptions);
    if (this.hasRemote) {
      const remotePath = this.getTaskResultPath(taskName, modelName, {
        ...pathOptions,
        remote: true,
      });
      if (
        (existsSync(remotePath) && options.prioritizeRemote) ||
        !existsSync(resultPath)
      )
        resultPath = remotePath;
    }
    if (!existsSync(resultPath)) {
      if (options.raiseIfNotFound)
        throw new Error(
          `Results for ${typeof modelName === 'string' ? modelName : String(modelName.name)} on ${taskName} not found in ${resultPath}`,
        );
      return null;
    }
    return TaskResult.fromDisk(resultPath);
  }

  // Saves a result in results/<model>/<revision>/<task>.json, the metadata of
  // a ModelMeta in model_meta.json beside it, and the settings of the run in
  // run_settings.jsonl.
  saveToCache(
    taskResult: TaskResult,
    modelName: string | ModelMeta,
    options: {
      readonly modelRevision?: string | null;
      readonly encodeKwargs?: EncodeKwargs | null;
    } = {},
  ): void {
    const resultPath = this.getTaskResultPath(taskResult.taskName, modelName, {
      modelRevision: options.modelRevision ?? null,
    });
    const folder = dirname(resultPath);
    mkdirSync(folder, { recursive: true });
    taskResult.toDisk(resultPath);
    if (typeof modelName !== 'string')
      writeFileSync(
        join(folder, 'model_meta.json'),
        pythonJsonDumps(modelName.toDict(), { indent: 4, default: String }),
      );
    const encodeKwargs = snakeCaseKeys(options.encodeKwargs ?? {});
    const runSettings = Object.entries(taskResult.scores).map(
      ([split, scores]) => ({
        task: taskResult.taskName,
        splits: [split],
        version: packageVersions(),
        encode_kwargs: encodeKwargs,
        subsets: [
          ...new Set(
            scores.map((entry) => String(entry['hf_subset'] ?? 'default')),
          ),
        ].sort(compareStrings),
      }),
    );
    if (runSettings.length > 0)
      writeAndMergeKeyedJson(join(folder, 'run_settings.jsonl'), runSettings);
  }

  // Deletes the cache folder.
  clearCache(): void {
    if (existsSync(this.cachePath) && statSync(this.cachePath).isDirectory())
      rmSync(this.cachePath, { recursive: true, force: true });
  }

  // The paths of the task result files, for the given models and tasks.
  getCachePaths(
    options: {
      readonly models?: readonly string[] | readonly ModelMeta[];
      readonly tasks?: readonly (string | ResultTask)[];
      readonly requireModelMeta?: boolean;
      readonly includeRemote?: boolean;
      readonly loadExperiments?: LoadExperimentName;
    } = {},
  ): string[] {
    return this.#resultPaths(options).map((entry) => entry.path);
  }

  // The (model folder, revision) pairs of the cache.
  getModels(
    options: {
      readonly tasks?: readonly string[];
      readonly requireModelMeta?: boolean;
      readonly includeRemote?: boolean;
    } = {},
  ): [model: string, revision: string][] {
    const pairs = new Map<string, [string, string]>();
    for (const entry of this.#resultPaths(options))
      pairs.set(JSON.stringify([entry.model, entry.revision]), [
        entry.model,
        entry.revision,
      ]);
    return [...pairs.values()];
  }

  // The names of the tasks of the cache.
  getTaskNames(
    options: {
      readonly models?: readonly string[] | readonly ModelMeta[];
      readonly requireModelMeta?: boolean;
      readonly includeRemote?: boolean;
    } = {},
  ): string[] {
    return [
      ...new Set(
        this.#resultPaths(options).map((entry) =>
          basename(entry.path, '.json'),
        ),
      ),
    ];
  }

  // The results of the cache, as one ModelResult for each model, revision
  // and experiment. Tasks are names or tasks; MTEB also takes benchmarks
  // from its registry.
  loadResults(
    options: {
      readonly models?: readonly string[] | readonly ModelMeta[];
      readonly tasks?: readonly (string | ResultTask)[];
      readonly requireModelMeta?: boolean;
      readonly includeRemote?: boolean;
      readonly validateAndFilter?: boolean;
      readonly onlyMainScore?: boolean;
      readonly loadExperiments?: LoadExperimentName;
      readonly experimentKwargs?:
        | Readonly<Record<string, unknown>>
        | readonly Readonly<Record<string, unknown>>[];
    } = {},
  ): BenchmarkResults {
    const loadExperiments =
      options.loadExperiments ?? LoadExperimentEnum.MATCH_KWARGS;
    const modelsAsModelMeta =
      options.models !== undefined &&
      options.models.length > 0 &&
      typeof options.models[0] !== 'string';
    const entries = this.#resultPaths({ ...options, loadExperiments });
    const taskByName = new Map<string, ResultTask | null>();
    for (const task of options.tasks ?? [])
      if (typeof task === 'string') taskByName.set(task, null);
      else taskByName.set(task.metadata.name, task);
    const experimentKwargs =
      options.experimentKwargs === undefined
        ? []
        : Array.isArray(options.experimentKwargs)
          ? options.experimentKwargs
          : [options.experimentKwargs];
    const experimentNames = new Set(
      experimentKwargs.map((kwargs) => serializeExperimentKwargsToName(kwargs)),
    );
    const identities = new Map<string, Identity | null>();
    const grouped = new Map<
      string,
      { identity: Identity; results: TaskResult[] }
    >();
    for (const entry of entries) {
      let taskResult = TaskResult.fromDisk(entry.path);
      if (options.onlyMainScore) taskResult = taskResult.onlyMainScore();
      const folder = dirname(entry.path);
      if (!identities.has(folder))
        identities.set(folder, identityOf(folder, entry));
      const identity = identities.get(folder);
      if (identity === undefined || identity === null) continue;
      if (options.validateAndFilter)
        taskResult = taskResult.validateAndFilterScores(
          taskByName.get(taskResult.taskName) ?? undefined,
        );
      if (
        experimentNames.size > 0 &&
        !experimentNames.has(identity.experimentName)
      )
        continue;
      if (
        loadExperiments === LoadExperimentEnum.MATCH_KWARGS &&
        !modelsAsModelMeta &&
        experimentNames.size === 0 &&
        identity.experimentName !== null
      )
        continue;
      const key = JSON.stringify([
        identity.modelName,
        identity.revision,
        identity.experimentName,
      ]);
      const group = grouped.get(key);
      if (group === undefined)
        grouped.set(key, { identity, results: [taskResult] });
      else group.results.push(taskResult);
    }
    return new BenchmarkResults(
      [...grouped.values()].map(
        ({ identity, results }) =>
          new ModelResult({
            modelName: identity.modelName,
            modelRevision: identity.revision,
            taskResults: results,
            experimentName: identity.experimentName,
            modelMeta: identity.modelMeta,
          }),
      ),
    );
  }

  toString(): string {
    return `ResultCache(cache_path=${this.cachePath})`;
  }

  #resultPaths(options: {
    readonly models?: readonly string[] | readonly ModelMeta[];
    readonly tasks?: readonly (string | ResultTask)[];
    readonly requireModelMeta?: boolean;
    readonly includeRemote?: boolean;
    readonly loadExperiments?: LoadExperimentName;
  }): ResultPath[] {
    const loadExperiments =
      options.loadExperiments ?? LoadExperimentEnum.NO_EXPERIMENTS;
    const withExperiments =
      loadExperiments !== LoadExperimentEnum.NO_EXPERIMENTS;
    let entries = resultPathsIn(
      join(this.cachePath, 'results'),
      withExperiments,
    );
    if (options.includeRemote ?? true)
      entries.push(...resultPathsIn(this.remoteResultsPath, withExperiments));
    entries = filterByModelAndRevision(
      entries,
      options.models,
      loadExperiments,
    );
    if (options.tasks !== undefined) {
      const names = new Set(
        options.tasks.map((task) =>
          typeof task === 'string' ? task : task.metadata.name,
        ),
      );
      entries = entries.filter((entry) =>
        names.has(basename(entry.path, '.json')),
      );
    }
    if (options.requireModelMeta ?? true)
      entries = entries.filter((entry) =>
        existsSync(join(dirname(entry.path), 'model_meta.json')),
      );
    return entries;
  }
}

// The model name, revision, experiment and metadata of a result folder.
type Identity = {
  readonly modelName: string;
  readonly revision: string | null;
  readonly experimentName: string | null;
  readonly modelMeta: ModelMeta | null;
};

// From the model_meta.json of the folder. A revision folder without one gets
// its name and revision from its path (MTEB also takes the metadata from its
// model registry, which this package does not have); an experiment folder
// without one is skipped.
function identityOf(folder: string, entry: ResultPath): Identity | null {
  const metaPath = join(folder, 'model_meta.json');
  if (!existsSync(metaPath)) {
    if (entry.experiment !== null) return null;
    return {
      modelName: entry.model.replaceAll('__', '/'),
      revision: entry.revision,
      experimentName: null,
      modelMeta: null,
    };
  }
  const json = pythonJsonLoads(readFileSync(metaPath, 'utf8'));
  if (!isPlainObject(json))
    throw new Error(`${metaPath} does not hold a JSON object`);
  const modelMeta = ModelMeta.fromDict(json);
  // MTEB's ModelResult requires a model name.
  if (modelMeta.name === null) throw new Error(`${metaPath} has no model name`);
  return {
    modelName: modelMeta.name,
    revision: modelMeta.revision,
    experimentName: serializeExperimentKwargsToName(modelMeta.experimentKwargs),
    modelMeta,
  };
}

// results/<model>/<revision>/<task>.json, and with experiments also
// results/<model>/<revision>/experiments/<name>/<task>.json. Sorted, where
// MTEB keeps the order of the file system.
function resultPathsIn(
  resultsFolder: string,
  withExperiments: boolean,
): ResultPath[] {
  const entries: ResultPath[] = [];
  for (const model of folders(resultsFolder))
    for (const revision of folders(join(resultsFolder, model))) {
      const revisionPath = join(resultsFolder, model, revision);
      for (const file of jsonFiles(revisionPath))
        entries.push({
          path: join(revisionPath, file),
          model,
          revision,
          experiment: null,
        });
      if (!withExperiments) continue;
      const experimentsPath = join(revisionPath, EXPERIMENTS_FOLDER_NAME);
      for (const experiment of folders(experimentsPath))
        for (const file of jsonFiles(join(experimentsPath, experiment)))
          entries.push({
            path: join(experimentsPath, experiment, file),
            model,
            revision,
            experiment,
          });
    }
  return entries;
}

function folders(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function jsonFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        entry.name !== 'model_meta.json',
    )
    .map((entry) => entry.name)
    .sort();
}

// The entries of the given models. A ModelMeta matches its revision, and
// with match_kwargs its experiment; a name matches every revision.
function filterByModelAndRevision(
  entries: ResultPath[],
  models: readonly string[] | readonly ModelMeta[] | undefined,
  loadExperiments: LoadExperimentName,
): ResultPath[] {
  if (models === undefined || models.length === 0) return entries;
  const matchKwargs = loadExperiments === LoadExperimentEnum.MATCH_KWARGS;
  const metas = models.filter(
    (model): model is ModelMeta => typeof model !== 'string',
  );
  if (metas.length > 0) {
    const wanted = new Set(
      metas.map((meta) =>
        JSON.stringify([
          meta.modelNameAsPath(),
          meta.revision ?? 'no_revision_available',
          matchKwargs ? meta.experimentName : null,
        ]),
      ),
    );
    return entries.filter((entry) =>
      wanted.has(
        JSON.stringify([
          entry.model,
          entry.revision,
          matchKwargs ? entry.experiment : null,
        ]),
      ),
    );
  }
  const names = new Set(
    models.map((model) =>
      String(model).replaceAll('/', '__').replaceAll(' ', '_'),
    ),
  );
  return entries.filter((entry) => names.has(entry.model));
}

// The revision folder of a model that changed last, or
// "no_revision_available" when the model has none.
function latestRevision(modelPath: string): string {
  const revisions = folders(modelPath);
  if (revisions.length === 0) return 'no_revision_available';
  return (
    revisions
      .map((name) => ({
        name,
        mtime: statSync(join(modelPath, name)).mtimeMs,
      }))
      .sort((left, right) => right.mtime - left.mtime)[0]?.name ??
    'no_revision_available'
  );
}

// MTEB's encode_kwargs are snake_case keyword arguments.
function snakeCaseKeys(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
      item,
    ]),
  );
}
