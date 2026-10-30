import { existsSync, readFileSync, statSync } from 'node:fs';

import { z } from 'zod';

import { RetrievalEvaluator } from '../evaluators/retrieval-evaluator.ts';
import { makeScoreDict } from '../evaluators/retrieval-metrics.ts';
import { isEncoder, isSearch } from '../models/models-protocols.ts';
import type { SearchProtocol } from '../models/models-protocols.ts';
import { SearchEncoderWrapper } from '../models/search-wrappers.ts';
import { TimingStack } from '../timing.ts';
import type {
  CorpusDatasetType,
  EncodeKwargs,
  QueryDatasetType,
  RelevantDocumentsType,
  RetrievalOutputType,
  TopRankedDocumentsType,
} from '../types/encoder-io.ts';
import type { Score } from '../types/result.ts';
import { AbsTask, type MTEBModels } from './abstask.ts';
import {
  type HubOptions,
  RetrievalDatasetLoader,
} from './retrieval-dataset-loaders.ts';
import type { TaskMetadata } from './task-metadata.ts';

// mteb/abstasks/retrieval.py. The conversion of the v1 dataset format, the
// HuggingFace loader and the descriptive statistics are not ported.

// The data of one split of a retrieval task.
export type RetrievalSplitData = {
  readonly corpus: CorpusDatasetType;
  queries: QueryDatasetType;
  relevantDocs: RelevantDocumentsType;
  topRanked: TopRankedDocumentsType | null;
};

// The predictions file of a task: the model, and the score of each document
// of each query, by subset and split.
export const predictionsFile = z
  .object({
    mteb_model_meta: z.record(z.string(), z.json()),
  })
  .catchall(
    z.record(
      z.string(),
      z.record(z.string(), z.record(z.string(), z.number())),
    ),
  )
  .transform(({ mteb_model_meta, ...subsets }) => ({
    mteb_model_meta,
    subsets,
  }));

// MTEB evaluates only the queries that have qrels. A query whose qrels all
// have the grade 0 stays in, and each model scores 0 on it.
function filterQueriesWithoutPositives(
  relevantDocs: RelevantDocumentsType,
  queries: QueryDatasetType,
): [RelevantDocumentsType, QueryDatasetType] {
  const kept = new Map(
    [...relevantDocs].filter(([, documents]) => documents.size > 0),
  );
  return [kept, queries.filter((query) => kept.has(query.id))];
}

// A retrieval task: each query ranks the documents of a corpus, and the
// relevant documents of each query score the ranking. A task with topRanked
// reranks the candidates of each query.
export abstract class AbsTaskRetrieval extends AbsTask<RetrievalSplitData> {
  // Drop each retrieved document whose id is the id of its query.
  ignoreIdenticalIds = false;
  kValues: readonly number[] = [1, 3, 5, 10, 20, 100, 1000];
  skipFirstResult = false;
  override readonly supportCrossEncoder: boolean = true;
  override readonly supportSearch: boolean = true;
  previousResultsModelMeta: Readonly<Record<string, Score>> | null = null;
  #topK: number | null = null;

  readonly #hub: HubOptions;

  constructor(options: {
    readonly metadata: TaskMetadata;
    readonly seed?: number;
    // Where loadData downloads the dataset of the metadata from.
    readonly hub?: HubOptions;
  }) {
    super(options);
    this.#hub = options.hub ?? {};
  }

  // Loads each eval split of each subset from the HuggingFace Hub, at the
  // revision of the metadata, or from the folder that the dataset path names.
  override async loadData(
    options: { readonly timer?: TimingStack } = {},
  ): Promise<void> {
    if (this.dataLoaded) return;
    const timer = options.timer ?? new TimingStack();
    const dataset = new Map<string, Map<string, RetrievalSplitData>>();
    {
      using _ = timer.phase('Data loading');
      const subsets = this.metadata.isMultilingual
        ? this.hfSubsets
        : ['default'];
      for (const subset of subsets)
        for (const split of this.evalSplits) {
          const data = await new RetrievalDatasetLoader({
            ...this.#hub,
            hfRepo: this.metadata.dataset.path,
            revision: this.metadata.dataset.revision,
            split,
            config: subset,
          }).load();
          const splits = dataset.get(subset) ?? new Map();
          splits.set(split, data);
          dataset.set(subset, splits);
        }
    }
    this.dataset = dataset;
    using _ = timer.phase('Dataset transform');
    this.datasetTransform();
  }

  override get abstaskPrompt(): string {
    return 'Retrieve text based on user query.';
  }

  // The number of documents that a search keeps for each query: the largest
  // k value, unless convertToReranking set it.
  get topK(): number {
    return this.#topK ?? Math.max(...this.kValues);
  }

  protected override async evaluateSubset(
    model: MTEBModels,
    dataSplit: RetrievalSplitData,
    options: {
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly encodeKwargs: EncodeKwargs;
      readonly predictionFolder: string | null;
      readonly timer: TimingStack;
    },
  ): Promise<Record<string, Score>> {
    const [relevantDocs, queries] = filterQueriesWithoutPositives(
      dataSplit.relevantDocs,
      dataSplit.queries,
    );
    dataSplit.relevantDocs = relevantDocs;
    dataSplit.queries = queries;
    const retriever = new RetrievalEvaluator(dataSplit.corpus, queries, {
      taskMetadata: this.metadata,
      hfSplit: options.hfSplit,
      hfSubset: options.hfSubset,
      topRanked: dataSplit.topRanked,
      topK: this.topK,
      timer: options.timer,
    });
    let searchModel: SearchProtocol;
    if (isEncoder(model) && !isSearch(model))
      searchModel = new SearchEncoderWrapper(model);
    else if (isSearch(model)) searchModel = model;
    else
      throw new TypeError(
        'RetrievalEvaluator expects a SearchInterface, Encoder, or CrossEncoder',
      );
    const results = await retriever.search(searchModel, options.encodeKwargs);
    if (options.predictionFolder !== null)
      this.saveTaskPredictions(
        Object.fromEntries(
          [...results].map(([query, scores]) => [
            query,
            Object.fromEntries(scores),
          ]),
        ),
        model,
        options.predictionFolder,
        options.hfSplit,
        options.hfSubset,
      );
    let evaluation;
    {
      using _ = options.timer.phase('Scoring', {
        split: options.hfSplit,
        subset: options.hfSubset,
      });
      evaluation = retriever.evaluate(
        relevantDocs,
        results,
        this.kValues,
        this.ignoreIdenticalIds,
        this.skipFirstResult,
      );
    }
    const taskScores = this.taskSpecificScores(
      evaluation.allScores,
      relevantDocs,
      results,
      options.hfSplit,
      options.hfSubset,
    );
    return makeScoreDict({
      ...evaluation,
      taskScores,
      previousResultsModelMeta: this.previousResultsModelMeta,
    });
  }

  // Scores that a task adds to the retrieval scores. Override it.
  taskSpecificScores(
    _scores: ReadonlyMap<string, Readonly<Record<string, number>>>,
    _qrels: RelevantDocumentsType,
    _results: RetrievalOutputType,
    _hfSplit: string,
    _hfSubset: string,
  ): Record<string, Score> {
    return {};
  }

  // Makes the task a reranking task: the candidates of each query are the
  // topK best documents of an earlier run that saved its predictions.
  async convertToReranking(topRankedPath: string, topK = 10): Promise<this> {
    this.#topK = topK;
    const path =
      existsSync(topRankedPath) && statSync(topRankedPath).isDirectory()
        ? this.predictionsPath(topRankedPath)
        : topRankedPath;
    if (!existsSync(path))
      throw new Error(
        `Can't find previous results for this task. File ${path} does not exist.`,
      );
    const previous = predictionsFile.parse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    if (!this.dataLoaded) await this.loadData();
    this.previousResultsModelMeta = previous.mteb_model_meta;
    for (const [subset, splits] of this.dataset ?? [])
      for (const [split, data] of splits) {
        const topRanked = previous.subsets[subset]?.[split];
        if (topRanked === undefined)
          throw new Error('Previous top ranked results is not a dictionary.');
        data.topRanked = new Map(
          Object.entries(topRanked).map(([query, scores]) => [
            query,
            Object.entries(scores)
              .map(([id, score], index) => ({ id, score, index }))
              // sorted(..., reverse=True) keeps equal scores in their order.
              .sort(
                (left, right) =>
                  right.score - left.score || left.index - right.index,
              )
              .slice(0, topK)
              .map(({ id }) => id),
          ]),
        );
      }
    return this;
  }
}
