// mteb/results/task_result.py.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import type { AbsTask } from '../abstasks/abstask.ts';
import {
  type TaskMetadata,
  checkLanguageCode,
} from '../abstasks/task-metadata.ts';
import { mean } from '../dependencies/numpy.ts';
import { Version } from '../dependencies/packaging.ts';
import {
  compareStrings,
  isPlainObject,
  pythonRound,
} from '../dependencies/python.ts';
import { type PhaseTiming, TimingStack } from '../timing.ts';
import type {
  HFSubset,
  Modalities,
  Score,
  ScoresDict,
  SplitName,
} from '../types/index.ts';
import { pythonJsonDumps, pythonJsonLoads } from './json.ts';

// The version of MTEB that this package ports. Results record it as their
// mteb_version, so MTEB reads them as results of this version.
export const MTEB_VERSION = '2.26.28';

// What a result reads of its task. An AbsTask has these members.
export type ResultTask = {
  readonly metadata: Pick<
    TaskMetadata,
    | 'name'
    | 'revision'
    | 'hfSubsetsToLangscripts'
    | 'domains'
    | 'modalities'
    | 'type'
    | 'isPublic'
  >;
  readonly evalSplits: AbsTask['evalSplits'];
  readonly hfSubsets: AbsTask['hfSubsets'];
  readonly isAggregate: AbsTask['isAggregate'];
};

// The criteria that TaskResult.isMergeable checks besides the task name.
export type Criteria = 'mteb_version' | 'dataset_revision';

const CRITERIA: readonly Criteria[] = ['mteb_version', 'dataset_revision'];

// A Python float: pydantic allows infinity and NaN, which Python's json
// writes as bare tokens. A copy of the float of model-meta.ts.
const float = z.custom<number>(
  (value) => typeof value === 'number',
  'Input should be a valid number',
);

const phaseTimingSchema = z.object({
  name: z.string(),
  start: float,
  end: float,
  split: z.string(),
  subset: z.string(),
});

// pydantic reads a number as seconds since the epoch, or as milliseconds when
// it is above 2e10, and a string as an ISO 8601 date or a number.
const dateSchema = z
  .union([z.number(), z.string(), z.date()])
  .nullable()
  .transform((value) => {
    if (value === null || value instanceof Date) return value;
    const number = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'string' && Number.isNaN(number))
      return new Date(value);
    return new Date(Math.abs(number) > 2e10 ? number : number * 1000);
  });

// Any value of a scores dict. pydantic's Any takes NaN and the infinities,
// which zod's number refuses.
const scoreSchema: z.ZodType<Score> = z.lazy(() =>
  z.union([
    z.custom<number>((value) => typeof value === 'number'),
    z.string(),
    z.boolean(),
    z.null(),
    z.array(scoreSchema),
    z.record(z.string(), scoreSchema),
  ]),
);

// A TaskResult as a dict: the keys of the file on disk.
const taskResultSchema = z.object({
  dataset_revision: z.string(),
  task_name: z.string(),
  mteb_version: z.string().nullable(),
  scores: z.record(z.string(), z.array(z.record(z.string(), scoreSchema))),
  evaluation_time: float.nullable(),
  kg_co2_emissions: float.nullable().default(null),
  date: dateSchema.default(null),
  evaluation_phases: z.array(phaseTimingSchema).nullable().default(null),
});

export type TaskResultDict = {
  readonly dataset_revision: string;
  readonly task_name: string;
  readonly mteb_version: string | null;
  readonly scores: Readonly<Record<SplitName, readonly ScoresDict[]>>;
  readonly evaluation_time: number | null;
  readonly kg_co2_emissions: number | null;
  readonly date: Date | null;
  readonly evaluation_phases: readonly PhaseTiming[] | null;
};

export type TaskResultInit = {
  readonly datasetRevision: string;
  readonly taskName: string;
  readonly mtebVersion: string | null;
  // For each split, the scores of each subset.
  readonly scores: Readonly<Record<SplitName, readonly ScoresDict[]>>;
  readonly evaluationTime: number | null;
  readonly kgCo2Emissions?: number | null;
  readonly date?: Date | null;
  readonly evaluationPhases?: readonly PhaseTiming[] | null;
};

// An error that stopped the evaluation of a task.
export type TaskError = {
  readonly taskName: string;
  readonly exception: string;
};

export const taskErrorSchema = z
  .object({ task_name: z.string(), exception: z.string() })
  .transform((error): TaskError => ({
    taskName: error.task_name,
    exception: error.exception,
  }));

// Marks a construction from data that is already valid (pydantic's
// model_construct). Only this module has it.
const TRUSTED = Symbol('trusted');

// The scores of a model on one task: for each split, the scores of each
// subset, with the time the evaluation took.
export class TaskResult {
  readonly datasetRevision: string;
  readonly taskName: string;
  readonly mtebVersion: string | null;
  readonly scores: Readonly<Record<SplitName, readonly ScoresDict[]>>;
  readonly evaluationTime: number | null;
  // evaluate sets it after the CO₂ tracker stops, as MTEB sets the field.
  kgCo2Emissions: number | null;
  readonly date: Date | null;
  readonly evaluationPhases: readonly PhaseTiming[] | null;
  // MTEB finds the task of a result in its task registry. This package has
  // no registry: a result knows its task when it was made from the task or
  // validated against it.
  #task: ResultTask | null = null;

  constructor(data: TaskResultInit, trust?: typeof TRUSTED) {
    if (trust !== TRUSTED)
      for (const subsets of Object.values(data.scores))
        for (const scores of subsets) validateScoresDict(scores);
    this.datasetRevision = data.datasetRevision;
    this.taskName = data.taskName;
    this.mtebVersion = data.mtebVersion;
    this.evaluationTime = data.evaluationTime;
    this.kgCo2Emissions = data.kgCo2Emissions ?? null;
    this.date = data.date ?? null;
    this.evaluationPhases = data.evaluationPhases ?? null;
    // pydantic runs the model validator that backfills the version of each
    // subset; model_construct does not.
    const version = data.mtebVersion;
    this.scores =
      trust === TRUSTED || version === null
        ? data.scores
        : Object.fromEntries(
            Object.entries(data.scores).map(([split, subsets]) => [
              split,
              subsets.map((scores) =>
                'mteb_version' in scores
                  ? scores
                  : { ...scores, mteb_version: version },
              ),
            ]),
          );
  }

  // Makes a result from the scores of a task, for each split and subset.
  static fromTaskResults(
    task: ResultTask,
    scores: ReadonlyMap<SplitName, ReadonlyMap<HFSubset, ScoresDict>>,
    evaluationTime: number,
    options: {
      readonly kgCo2Emissions?: number | null;
      readonly date?: Date | null;
      readonly evaluationPhases?: readonly PhaseTiming[] | null;
    } = {},
  ): TaskResult {
    const subsetLanguages = task.metadata.hfSubsetsToLangscripts;
    const flatScores: Record<SplitName, ScoresDict[]> = {};
    for (const [split, subsetScores] of scores) {
      for (const [subset, subsetScore] of subsetScores) {
        // An aggregated task scores the "default" subset, which the mapping
        // does not have: it takes all the languages of the mapping.
        const languages = subsetLanguages.get(subset) ?? [
          ...new Set([...subsetLanguages.values()].flat()),
        ];
        (flatScores[split] ??= []).push({
          ...subsetScore,
          hf_subset: subset,
          languages: [...languages],
          mteb_version:
            'mteb_version' in subsetScore
              ? (subsetScore['mteb_version'] ?? null)
              : MTEB_VERSION,
        });
      }
    }
    const result = new TaskResult({
      datasetRevision: task.metadata.revision,
      taskName: task.metadata.name,
      mtebVersion:
        TaskResult.#computeTopLevelMtebVersion(flatScores) ?? MTEB_VERSION,
      scores: flatScores,
      evaluationTime,
      kgCo2Emissions: options.kgCo2Emissions ?? null,
      date: options.date ?? null,
      evaluationPhases: options.evaluationPhases ?? null,
    });
    result.#task = task;
    return result;
  }

  // model_construct: no validation and no backfill.
  static fromValidated(data: TaskResultInit): TaskResult {
    return new TaskResult(data, TRUSTED);
  }

  // model_validate of the dict form.
  static fromDict(data: unknown): TaskResult {
    const parsed = taskResultSchema.parse(data);
    return new TaskResult({
      datasetRevision: parsed.dataset_revision,
      taskName: parsed.task_name,
      mtebVersion: parsed.mteb_version,
      scores: parsed.scores,
      evaluationTime: parsed.evaluation_time,
      kgCo2Emissions: parsed.kg_co2_emissions,
      date: parsed.date,
      evaluationPhases: parsed.evaluation_phases,
    });
  }

  // model_dump.
  toDict(): TaskResultDict {
    return {
      dataset_revision: this.datasetRevision,
      task_name: this.taskName,
      mteb_version: this.mtebVersion,
      scores: structuredClone(this.scores),
      evaluation_time: this.evaluationTime,
      kg_co2_emissions: this.kgCo2Emissions,
      date: this.date,
      evaluation_phases:
        this.evaluationPhases?.map((phase) => ({
          ...phase,
        })) ?? null,
    };
  }

  // Writes the result as MTEB does: the scores rounded to 6 digits and the
  // date in seconds since the epoch.
  toDisk(path: string): void {
    writeFileSync(
      path,
      pythonJsonDumps(
        {
          ...this.toDict(),
          scores: roundScores(this.scores, 6),
          date: this.date === null ? null : this.date.getTime() / 1000,
        },
        { indent: 2 },
      ),
    );
  }

  // Reads a result file. MTEB also reads the format of versions before
  // 1.11.0, through its task registry; this package does not.
  static fromDisk(path: string): TaskResult {
    const data = pythonJsonLoads(readFileSync(path, 'utf8'));
    const version = isPlainObject(data) ? data['mteb_version'] : undefined;
    const minVersion = TaskResult.#parseMtebVersionMin(
      typeof version === 'string' ? version : null,
    );
    const before111 =
      (minVersion !== null &&
        minVersion.compare(Version.parse('1.11.0')) < 0) ||
      !(isPlainObject(data) && 'mteb_version' in data);
    try {
      return TaskResult.fromDict(data);
    } catch (error) {
      if (!before111) throw error;
      throw new Error(
        `${path} has the result format of MTEB before 1.11.0, which this package does not read.`,
        { cause: error },
      );
    }
  }

  // The languages of the scores, without their scripts.
  get languages(): string[] {
    const languages = new Set<string>();
    for (const subsets of Object.values(this.scores))
      for (const scores of subsets)
        for (const language of languagesOf(scores))
          languages.add(language.split('-')[0] ?? language);
    return [...languages];
  }

  // The task of the result.
  get task(): ResultTask {
    if (this.#task === null)
      throw new Error(
        `The task of ${this.taskName} is unknown: this package has no task registry. Validate the result against its task first (validateAndFilterScores).`,
      );
    return this.#task;
  }

  get domains(): NonNullable<ResultTask['metadata']['domains']> {
    return this.task.metadata.domains ?? [];
  }

  get modalities(): readonly Modalities[] {
    return this.task.metadata.modalities;
  }

  get taskType(): string {
    return this.task.metadata.type;
  }

  get isPublic(): boolean {
    return this.task.metadata.isPublic;
  }

  get mainScore(): number {
    return this.getScore();
  }

  get hfSubsets(): string[] {
    const subsets = new Set<string>();
    for (const scores of Object.values(this.scores).flat())
      subsets.add(String(scores['hf_subset']));
    return [...subsets];
  }

  get evalSplits(): string[] {
    return Object.keys(this.scores);
  }

  // A text bar chart of the evaluation phases.
  plotEvaluationPhases(): string {
    const stack = new TimingStack();
    if (this.evaluationPhases) stack.phases.push(...this.evaluationPhases);
    return stack.plot();
  }

  // The aggregation of a score over the splits, the languages and the
  // scripts. By default, the mean of the main scores.
  getScore(
    options: {
      readonly splits?: readonly SplitName[];
      readonly languages?: readonly string[];
      readonly scripts?: readonly string[];
      readonly getter?: (scores: ScoresDict) => Score;
      readonly aggregation?: (values: Score[]) => number;
    } = {},
  ): number {
    const splits = options.splits ?? Object.keys(this.scores);
    const getter = options.getter ?? ((scores) => scores['main_score'] ?? null);
    const aggregation =
      options.aggregation ?? ((values: Score[]) => mean(values.map(toNumber)));
    const languageScripts = LanguageScripts.fromLanguagesAndScripts(
      options.languages,
      options.scripts,
    );
    const values: Score[] = [];
    for (const split of splits) {
      const subsets = this.scores[split];
      if (subsets === undefined)
        throw new Error(`Split ${split} not found in scores`);
      for (const scores of subsets) {
        const matches = languagesOf(scores).some(
          (language) =>
            languageScripts.containsLanguage(language) &&
            (!options.scripts?.length ||
              languageScripts.containsLangscriptScript(language)),
        );
        if (matches) values.push(getter(scores));
      }
    }
    return aggregation(values);
  }

  // A result with only the main score of each subset.
  onlyMainScore(): TaskResult {
    const scores = Object.fromEntries(
      Object.entries(this.scores).map(([split, subsets]) => [
        split,
        subsets.map((scores) => ({
          hf_subset: get(scores, 'hf_subset', 'default'),
          main_score: get(scores, 'main_score', NaN),
          languages: get(scores, 'languages', []),
        })),
      ]),
    );
    const result = TaskResult.fromValidated({ ...this.#init(), scores });
    result.#task = this.#task;
    return result;
  }

  // Keeps the splits and subsets of the task and adds a NaN main score for
  // each one that the result lacks.
  validateAndFilterScores(task?: ResultTask): TaskResult {
    const resolved = task ?? this.task;
    const splits = resolved.evalSplits;
    const subsets = new Set(resolved.hfSubsets);
    const missingEntry = (subset: string): ScoresDict => ({
      hf_subset: subset,
      main_score: NaN,
      languages: [
        ...(resolved.metadata.hfSubsetsToLangscripts.get(subset) ?? []),
      ],
    });
    const newScores: Record<SplitName, ScoresDict[]> = {};
    const seenSplits = new Set<string>();
    for (const [split, splitScores] of Object.entries(this.scores)) {
      if (!splits.includes(split)) continue;
      // An aggregate task has only the default subset, though its metadata
      // can have several.
      const kept = resolved.isAggregate
        ? splitScores.filter((scores) => scores['hf_subset'] === 'default')
        : splitScores.filter((scores) =>
            subsets.has(String(scores['hf_subset'])),
          );
      const seenSubsets = new Set(
        kept.map((scores) => String(scores['hf_subset'])),
      );
      if (resolved.isAggregate) seenSubsets.add('default');
      newScores[split] = kept;
      const complete =
        seenSubsets.size === subsets.size &&
        [...subsets].every((subset) => seenSubsets.has(subset));
      if (!complete && !(resolved.isAggregate && seenSubsets.has('default')))
        for (const subset of subsets)
          if (!seenSubsets.has(subset)) kept.push(missingEntry(subset));
      seenSplits.add(split);
    }
    for (const split of splits)
      if (!seenSplits.has(split))
        newScores[split] = [...subsets].map(missingEntry);
    const result = TaskResult.fromValidated({
      ...this.#init(),
      scores: newScores,
    });
    result.#task = resolved;
    return result;
  }

  // Whether this result and another result, or a task, are of the same task
  // and match on the criteria.
  isMergeable(
    result: TaskResult | ResultTask,
    options: {
      readonly criteria?: readonly Criteria[];
      readonly raiseError?: boolean;
    } = {},
  ): boolean {
    const criteria = (options.criteria ?? ['dataset_revision']).map(
      (criterion) => {
        if (!CRITERIA.includes(criterion))
          throw new Error(
            `${String(criterion)} is not a valid Criteria. Valid options are: ${CRITERIA.join(', ')}`,
          );
        return criterion;
      },
    );
    const [name, revision, mtebVersion] =
      result instanceof TaskResult
        ? [result.taskName, result.datasetRevision, result.mtebVersion]
        : [result.metadata.name, result.metadata.revision, MTEB_VERSION];
    const refuse = (message: string): false => {
      if (options.raiseError) throw new Error(message);
      return false;
    };
    if (this.taskName !== name)
      return refuse(
        `Cannot merge TaskResult objects as they are derived from different tasks (${this.taskName} and ${name})`,
      );
    if (criteria.includes('mteb_version') && this.mtebVersion !== mtebVersion)
      return refuse(
        `Cannot merge TaskResult objects as they are derived from different MTEB versions (${this.mtebVersion} (loaded) and ${mtebVersion} (current))`,
      );
    if (
      criteria.includes('dataset_revision') &&
      this.datasetRevision !== revision
    )
      return refuse(
        `Cannot merge TaskResult objects as they are derived from different dataset revisions (${this.datasetRevision} and ${revision})`,
      );
    return true;
  }

  // The scores of both results; a subset of the new result replaces the
  // same subset of this one.
  merge(
    newResults: TaskResult,
    options: { readonly criteria?: readonly Criteria[] } = {},
  ): TaskResult {
    this.isMergeable(newResults, { ...options, raiseError: true });
    const mergedScores: Record<SplitName, readonly ScoresDict[]> = {
      ...this.scores,
    };
    for (const [split, scores] of Object.entries(newResults.scores)) {
      const existing = mergedScores[split];
      mergedScores[split] =
        existing === undefined
          ? scores
          : TaskResult.#mergeSplitScores(existing, scores);
    }
    const mergedCo2 =
      this.kgCo2Emissions !== null || newResults.kgCo2Emissions !== null
        ? (this.kgCo2Emissions || 0) + (newResults.kgCo2Emissions || 0)
        : null;
    const mergedTime =
      this.evaluationTime !== null || newResults.evaluationTime !== null
        ? (this.evaluationTime ?? 0) + (newResults.evaluationTime ?? 0)
        : null;
    let mergedPhases: PhaseTiming[] | null = null;
    if (
      this.evaluationPhases !== null ||
      newResults.evaluationPhases !== null
    ) {
      mergedPhases = [...(this.evaluationPhases ?? [])];
      if (newResults.evaluationPhases !== null) {
        const offset =
          this.evaluationTime ||
          (this.evaluationPhases?.length
            ? Math.max(...this.evaluationPhases.map((phase) => phase.end))
            : 0);
        for (const phase of newResults.evaluationPhases)
          mergedPhases.push({
            ...phase,
            start: phase.start + offset,
            end: phase.end + offset,
          });
      }
    }
    const date =
      newResults.date !== null &&
      (this.date === null || newResults.date > this.date)
        ? newResults.date
        : this.date;
    return new TaskResult({
      datasetRevision: newResults.datasetRevision,
      taskName: newResults.taskName,
      mtebVersion: TaskResult.#computeTopLevelMtebVersion(mergedScores),
      scores: mergedScores,
      evaluationTime: mergedTime,
      kgCo2Emissions: mergedCo2,
      date,
      evaluationPhases: mergedPhases,
    });
  }

  // For each split of the task, the subsets that the result lacks.
  getMissingEvaluations(task: ResultTask): Map<SplitName, readonly HFSubset[]> {
    const missing = new Map<SplitName, readonly HFSubset[]>();
    for (const split of task.evalSplits) {
      const scores = this.scores[split];
      if (scores === undefined) {
        missing.set(split, task.hfSubsets);
        continue;
      }
      const present = new Set(
        scores.map((entry) => String(entry['hf_subset'])),
      );
      const subsets = [...new Set(task.hfSubsets)].filter(
        (subset) => !present.has(subset),
      );
      if (subsets.length > 0) missing.set(split, subsets);
    }
    return missing;
  }

  #init(): TaskResultInit {
    return {
      datasetRevision: this.datasetRevision,
      taskName: this.taskName,
      mtebVersion: this.mtebVersion,
      scores: this.scores,
      evaluationTime: this.evaluationTime,
      kgCo2Emissions: this.kgCo2Emissions,
      date: this.date,
      evaluationPhases: this.evaluationPhases,
    };
  }

  // The lowest version of a stored mteb_version, which can be a range such
  // as "2.12.16-2.15.4". Null when the version cannot be read.
  static #parseMtebVersionMin(text: string | null): Version | null {
    if (text === null) return null;
    const version = Version.tryParse(text);
    if (version !== null) return version;
    return text.includes('-')
      ? Version.tryParse(text.slice(0, text.indexOf('-')))
      : null;
  }

  // The version of all subsets, or the range from the lowest to the highest
  // when they differ. Null when no subset has a version.
  static #computeTopLevelMtebVersion(
    scores: Readonly<Record<SplitName, readonly ScoresDict[]>>,
  ): string | null {
    const versions = new Set<string>();
    for (const subsets of Object.values(scores))
      for (const entry of subsets) {
        const version = entry['mteb_version'];
        if (version !== undefined && version !== null)
          versions.add(String(version));
      }
    if (versions.size === 0) return null;
    const sorted = [...versions]
      .map((version) => Version.parse(version))
      .sort((left, right) => left.compare(right));
    const min = String(sorted[0]);
    const max = String(sorted.at(-1));
    return min === max ? min : `${min}-${max}`;
  }

  static #mergeSplitScores(
    existing: readonly ScoresDict[],
    newScores: readonly ScoresDict[],
  ): ScoresDict[] {
    const merged = new Map<unknown, ScoresDict>();
    for (const scores of [...existing, ...newScores])
      merged.set(scores['hf_subset'], scores);
    return [...merged.values()];
  }
}

function validateScoresDict(scores: ScoresDict): void {
  if (typeof scores !== 'object' || scores === null || Array.isArray(scores))
    throw new Error('Scores should be a dictionary');
  if (!('main_score' in scores))
    throw new Error("'main_score' should be in scores");
  if (typeof scores['hf_subset'] !== 'string')
    throw new Error('hf_subset should be in scores and should be a string');
  if (!Array.isArray(scores['languages']))
    throw new Error('languages should be in scores and should be a list');
  try {
    pythonJsonDumps(scores);
  } catch (error) {
    throw new Error(`Scores are not json serializable: ${String(error)}`, {
      cause: error,
    });
  }
}

// dict.get(key, fallback): a key with a None value gives None.
function get(scores: ScoresDict, key: string, fallback: Score): Score {
  return key in scores ? (scores[key] ?? null) : fallback;
}

function languagesOf(scores: ScoresDict): string[] {
  const languages = scores['languages'];
  return Array.isArray(languages) ? languages.map(String) : [];
}

// np.mean takes numbers only.
function toNumber(value: Score): number {
  if (typeof value !== 'number')
    throw new TypeError(`Cannot average the score ${JSON.stringify(value)}`);
  return value;
}

// TaskResult._round_scores: the floats of the dicts, and the floats and dicts
// of their lists, rounded to digits decimals. A list in a list stays as it is.
function roundScores(value: unknown, digits: number): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown) =>
      typeof item === 'number'
        ? pythonRound(item, digits)
        : isPlainObject(item)
          ? roundScores(item, digits)
          : item,
    );
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === 'number'
        ? pythonRound(item, digits)
        : Array.isArray(item) || isPlainObject(item)
          ? roundScores(item, digits)
          : item,
    ]),
  );
}

// mteb/languages/language_scripts.py: a set of languages and scripts.
class LanguageScripts {
  readonly languageScripts: ReadonlySet<string>;
  readonly scripts: ReadonlySet<string>;
  readonly languages: ReadonlySet<string>;

  private constructor(
    languageScripts: Set<string>,
    scripts: Set<string>,
    languages: Set<string>,
  ) {
    this.languageScripts = languageScripts;
    this.scripts = scripts;
    this.languages = languages;
  }

  static fromLanguagesAndScripts(
    languages?: readonly string[],
    scripts?: readonly string[],
  ): LanguageScripts {
    const languageScripts = new Set<string>();
    const scriptCodes = new Set<string>();
    const normalized = new Set<string>();
    for (const script of scripts ?? []) {
      checkLanguageCode(script);
      scriptCodes.add(script);
    }
    for (const language of languages ?? []) {
      const parts = language.split('-');
      checkLanguageCode(language);
      if (parts.length === 2) {
        normalized.add(parts[0] ?? '');
        languageScripts.add(language);
        scriptCodes.add(parts[1] ?? '');
      } else normalized.add(language);
    }
    return new LanguageScripts(languageScripts, scriptCodes, normalized);
  }

  containsLanguage(language: string): boolean {
    if (this.languageScripts.size === 0 && this.languages.size === 0)
      return true;
    const parts = language.split('-');
    if (parts.length === 2 && this.languageScripts.has(language)) return true;
    return this.languages.has(parts.length === 2 ? (parts[0] ?? '') : language);
  }

  containsLangscriptScript(langscript: string): boolean {
    return this.scripts.has(langscript.slice(langscript.lastIndexOf('-') + 1));
  }
}

// One line of run_settings.jsonl: the settings of an evaluation of a task.
type RunSettingsEntry = Readonly<Record<string, unknown>>;

// The entries of a run_settings.jsonl file, without the lines that are not
// JSON objects.
function readRunSettingsFromFile(path: string): RunSettingsEntry[] {
  if (!existsSync(path)) return [];
  const entries: RunSettingsEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;
    try {
      const parsed = pythonJsonLoads(stripped);
      if (isPlainObject(parsed)) entries.push(parsed);
    } catch {
      continue;
    }
  }
  return entries;
}

// One (task, split, subset) scope, the key of its settings and the settings,
// for each subset of each split of an entry.
function* expandRunSettingsEntry(
  entry: RunSettingsEntry,
): Generator<
  [scope: [string, string, string], key: string, settings: RunSettingsEntry]
> {
  const { task, ...rest } = entry;
  const settings: Record<string, unknown> = { ...rest };
  const pop = (name: string): unknown => {
    const value = settings[name];
    delete settings[name];
    return value ?? null;
  };
  // Entries written before splits and subsets were combined have a single
  // split and subset.
  const splits = pop('splits');
  const splitList = Array.isArray(splits) ? splits : [pop('split')];
  const subsets = pop('subsets');
  const subsetList = Array.isArray(subsets) ? subsets : [pop('subset')];
  const key = pythonJsonDumps(sortKeys(settings), { default: String });
  for (const oneSplit of splitList)
    for (const oneSubset of subsetList)
      if (oneSplit !== null && oneSubset !== null)
        yield [
          [String(task), String(oneSplit), String(oneSubset)],
          key,
          settings,
        ];
}

// Writes the entries to a run_settings.jsonl file, merged with the entries
// already in it. Each (task, split, subset) keeps the settings of its last
// entry. The splits of a task with the same settings and the same subsets
// share a line.
export function writeAndMergeKeyedJson(
  path: string,
  entries: readonly RunSettingsEntry[],
): void {
  const settingsByKey = new Map<string, RunSettingsEntry>();
  const runSettings = new Map<
    string,
    { scope: [string, string, string]; key: string }
  >();
  for (const entry of [...readRunSettingsFromFile(path), ...entries])
    for (const [scope, key, settings] of expandRunSettingsEntry(entry)) {
      settingsByKey.set(key, settings);
      runSettings.set(JSON.stringify(scope), { scope, key });
    }
  // (task, settings key) -> split -> subsets
  const grouped = new Map<
    string,
    { task: string; key: string; splits: Map<string, string[]> }
  >();
  for (const {
    scope: [task, split, subset],
    key,
  } of runSettings.values()) {
    const groupKey = JSON.stringify([task, key]);
    let group = grouped.get(groupKey);
    if (group === undefined) {
      group = { task, key, splits: new Map() };
      grouped.set(groupKey, group);
    }
    let subsets = group.splits.get(split);
    if (subsets === undefined) {
      subsets = [];
      group.splits.set(split, subsets);
    }
    subsets.push(subset);
  }
  const lines: string[] = [];
  for (const { task, key, splits } of grouped.values()) {
    const rows = new Map<string, { subsets: string[]; splits: string[] }>();
    for (const [split, subsets] of splits) {
      const sorted = [...new Set(subsets)].sort(compareStrings);
      const rowKey = JSON.stringify(sorted);
      let row = rows.get(rowKey);
      if (row === undefined) {
        row = { subsets: sorted, splits: [] };
        rows.set(rowKey, row);
      }
      row.splits.push(split);
    }
    for (const row of rows.values())
      lines.push(
        pythonJsonDumps(
          {
            task,
            splits: [...row.splits].sort(compareStrings),
            ...settingsByKey.get(key),
            subsets: row.subsets,
          },
          { default: String },
        ) + '\n',
      );
  }
  writeFileSync(path, lines.join(''));
}

// json.dumps(..., sort_keys=True) sorts the keys at every depth.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareStrings)
      .map((key) => [key, sortKeys(value[key])]),
  );
}
