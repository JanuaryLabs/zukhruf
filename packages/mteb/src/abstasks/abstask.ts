import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Dataset,
  type DatasetDict,
  type HubOptions,
  loadDataset,
  select,
} from '../dependencies/datasets.ts';
import { MultiLabelBinarizer } from '../dependencies/sklearn.ts';
import { labelSetsOf } from '../evaluators/sklearn-evaluator.ts';
import type {
  CrossEncoderProtocol,
  EncoderProtocol,
  SearchProtocol,
} from '../models/models-protocols.ts';
import {
  isCrossEncoder,
  isEncoder,
  isSearch,
} from '../models/models-protocols.ts';
import { jsonLoadsInOrder, pythonJsonDumps } from '../results/json.ts';
import { TimingStack, monotonic } from '../timing.ts';
import type { EncodeKwargs } from '../types/encoder-io.ts';
import type { HFSubset, Score } from '../types/result.ts';
import { iterativeTrainTestSplit } from './stratification.ts';
import type { TaskMetadata } from './task-metadata.ts';

// mteb/abstasks/abstask.py. Python declares the metadata of a task on its
// class; a subclass here gives it to the constructor, because the field
// initializers of a subclass run only after the constructor of AbsTask.
// Fast loading, descriptive statistics, the push to the Hub and the stratified
// subsampling of single labels are not ported.

// The models that a task evaluates.
export type MTEBModels =
  EncoderProtocol | CrossEncoderProtocol | SearchProtocol;

export type EvaluateTaskOptions = {
  readonly encodeKwargs: EncodeKwargs;
  // The folder that keeps the predictions of the model.
  readonly predictionFolder?: string | null;
  readonly timer?: TimingStack;
};

// get_abstask_prompt finds the task class of a task name among the imported
// task classes. This port cannot list classes, so each task records its
// prompt when it is constructed.
const taskNameToPrompt = new Map<string, string>();

// The prompt of the abstract task class of a task, or an empty string.
export function getAbstaskPrompt(taskName: string): string {
  return taskNameToPrompt.get(taskName) ?? '';
}

// _multilabel_subsampling: each split of splits keeps nSamples of its rows,
// the test side of an iterative stratification over the label sets of the
// label column, in the order of the split.
export function multilabelSubsampling(
  datasetDict: DatasetDict,
  seed: number,
  splits: readonly string[] = ['test'],
  label = 'label',
  nSamples = 2048,
): DatasetDict {
  const subsampled = new Map(datasetDict);
  for (const split of splits) {
    const dataset = subsampled.get(split);
    if (dataset === undefined) throw new Error(`KeyError: '${split}'`);
    const labels = new MultiLabelBinarizer().fitTransform(
      labelSetsOf(dataset, label),
    );
    const { test } = iterativeTrainTestSplit(
      labels,
      nSamples / dataset.rows.length,
      seed,
    );
    subsampled.set(split, select(dataset, test));
  }
  return subsampled;
}

// One task: its metadata, its data by subset and split, and the evaluation
// of a model on each subset.
export abstract class AbsTask<SplitData = unknown> {
  readonly metadata: TaskMetadata;
  readonly seed: number;
  // Where loadData downloads the dataset of the metadata from.
  protected readonly hub: HubOptions;
  // The data by subset and split, or null before loadData.
  dataset: Map<HFSubset, Map<string, SplitData>> | null = null;
  hfSubsets: HFSubset[];
  #evalSplits: readonly string[] | null = null;
  readonly supportCrossEncoder: boolean = false;
  readonly supportSearch: boolean = false;

  constructor(options: {
    readonly metadata: TaskMetadata;
    readonly seed?: number;
    readonly hub?: HubOptions;
  }) {
    this.metadata = options.metadata;
    this.seed = options.seed ?? 42;
    this.hub = options.hub ?? {};
    this.hfSubsets = [...this.metadata.hfSubsets];
    taskNameToPrompt.set(this.metadata.name, this.abstaskPrompt);
  }

  // MTEB's data_loaded: whether the task holds its data.
  get dataLoaded(): boolean {
    return this.dataset !== null;
  }

  // The instruction of the task type, for models that take instructions.
  get abstaskPrompt(): string {
    return '';
  }

  // load_data: loads the split data of each subset, then runs
  // datasetTransform.
  async loadData(
    options: { readonly timer?: TimingStack } = {},
  ): Promise<void> {
    if (this.dataLoaded) return;
    const timer = options.timer ?? new TimingStack();
    {
      using _ = timer.phase('Data loading');
      this.dataset = await this.loadSplits();
    }
    using _ = timer.phase('Dataset transform');
    this.datasetTransform();
  }

  // The split data of each subset. A task whose split data is a Dataset
  // returns loadDatasets(); AbsTaskRetrieval reads its own files.
  protected abstract loadSplits(): Promise<
    Map<HFSubset, Map<string, SplitData>>
  >;

  // load_dataset of the metadata (abstask.py:409-420): every split of the
  // config of each subset of a multilingual task, or of the config that the
  // metadata names.
  protected async loadDatasets(): Promise<Map<HFSubset, Map<string, Dataset>>> {
    const { path, revision, name, split } = this.metadata.dataset;
    if (split !== undefined)
      throw new Error(
        `${this.metadata.name}: this port does not load one split of a dataset (dataset.split).`,
      );
    const load = async (config: string | null) =>
      new Map(await loadDataset({ ...this.hub, path, revision, name: config }));
    const dataset = new Map<HFSubset, Map<string, Dataset>>();
    if (this.metadata.isMultilingual)
      for (const subset of this.hfSubsets)
        dataset.set(subset, await load(subset));
    else dataset.set('default', await load(name ?? null));
    return dataset;
  }

  // A hook that a task overrides to change its data after loadData.
  datasetTransform(): void {}

  // The scores of the model on each subset of a split.
  async evaluate(
    model: MTEBModels,
    split: string,
    subsetsToRun: readonly HFSubset[] | null,
    options: EvaluateTaskOptions,
  ): Promise<Map<HFSubset, Record<string, Score>>> {
    const timer = options.timer ?? new TimingStack();
    if (isCrossEncoder(model) && !this.supportCrossEncoder)
      throw new TypeError(
        `Model ${model.mtebModelMeta.name} is a CrossEncoder, but this task ${this.metadata.name} does not support CrossEncoders. Please use a Encoder model instead.`,
      );
    if (isSearch(model) && !isEncoder(model) && !this.supportSearch)
      throw new TypeError(
        `Model ${model.mtebModelMeta.name} is a SearchProtocol, but this task ${this.metadata.name} does not support Search. Please use a Encoder model instead.`,
      );
    if (!this.dataLoaded) {
      const phasesBefore = timer.phases.length;
      const start = monotonic();
      await this.loadData({ timer });
      if (timer.phases.length === phasesBefore)
        timer.addPhase('Data loading', {
          start,
          end: monotonic(),
          split: '',
          subset: '',
        });
    }
    const dataset = this.dataset;
    if (dataset === null) throw new Error('The task loaded no dataset.');
    let subsets =
      this.hfSubsets.length > 0 ? [...this.hfSubsets] : [...dataset.keys()];
    if (subsetsToRun !== null)
      subsets = subsets.filter((subset) => subsetsToRun.includes(subset));
    const scores = new Map<HFSubset, Record<string, Score>>();
    for (const subset of subsets) {
      const splitData = dataset.get(subset)?.get(split);
      if (splitData === undefined)
        throw new Error(`KeyError: '${subset}' / '${split}'`);
      const subsetScores = await this.evaluateSubset(model, splitData, {
        hfSplit: split,
        hfSubset: subset,
        encodeKwargs: options.encodeKwargs,
        predictionFolder: options.predictionFolder ?? null,
        timer,
      });
      this.addMainScore(subsetScores);
      scores.set(subset, subsetScores);
    }
    return scores;
  }

  protected abstract evaluateSubset(
    model: MTEBModels,
    dataSplit: SplitData,
    options: {
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly encodeKwargs: EncodeKwargs;
      readonly predictionFolder: string | null;
      readonly timer: TimingStack;
    },
  ): Promise<Record<string, Score>>;

  // Adds the predictions of a split to the predictions file of the task.
  protected saveTaskPredictions(
    predictions: unknown,
    model: MTEBModels,
    predictionFolder: string,
    hfSplit: string,
    hfSubset: string,
  ): void {
    const path = this.predictionsPath(predictionFolder);
    const existing: unknown = existsSync(path)
      ? jsonLoadsInOrder(readFileSync(path, 'utf8'))
      : new Map([
          [
            'mteb_model_meta',
            new Map([
              ['model_name', model.mtebModelMeta.name],
              ['revision', model.mtebModelMeta.revision],
            ]),
          ],
        ]);
    if (!(existing instanceof Map))
      throw new TypeError(`${path} is not an object.`);
    if (!existing.has(hfSubset)) existing.set(hfSubset, new Map());
    const splits: unknown = existing.get(hfSubset);
    // existing_results[hf_subset][hf_split] = predictions (abstask.py:307)
    // raises a TypeError when the subset is not a dict.
    if (!(splits instanceof Map))
      throw new TypeError(`${path}: ${hfSubset} is not an object.`);
    splits.set(hfSplit, predictions);
    writeFileSync(path, pythonJsonDumps(existing));
  }

  protected predictionsPath(outputFolder: string): string {
    mkdirSync(outputFolder, { recursive: true });
    return join(outputFolder, this.predictionFileName);
  }

  get predictionFileName(): string {
    return `${this.metadata.name}_predictions.json`;
  }

  // The 3-letter languages of the task's subsets.
  get languages(): string[] {
    if (this.hfSubsets.length > 0) {
      const languages = new Set<string>();
      for (const subset of this.hfSubsets)
        for (const langscript of this.metadata.hfSubsetsToLangscripts.get(
          subset,
        ) ?? [])
          languages.add(langscript.split('-')[0] ?? '');
      return [...languages].sort();
    }
    return [...this.metadata.languages];
  }

  filterEvalSplits(evalSplits: readonly string[] | null): this {
    this.#evalSplits = evalSplits;
    return this;
  }

  get evalSplits(): readonly string[] {
    if (this.#evalSplits !== null && this.#evalSplits.length > 0)
      return this.#evalSplits;
    return this.metadata.evalSplits;
  }

  get modalities(): readonly string[] {
    return this.metadata.modalities;
  }

  get isAggregate(): boolean {
    return false;
  }

  get supersededBy(): string | null {
    return this.metadata.supersededBy ?? null;
  }

  protected addMainScore(scores: Record<string, Score>): void {
    const main = scores[this.metadata.mainScore];
    if (main === undefined)
      throw new Error(`KeyError: '${this.metadata.mainScore}'`);
    scores.main_score = main;
  }

  unloadData(): void {
    this.dataset = null;
  }
}
