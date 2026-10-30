import type { TaskMetadata } from '../abstasks/task-metadata.ts';
import { createDataloaderFromTexts } from '../create-dataloaders.ts';
import type { Dataset } from '../dependencies/datasets.ts';
import { MiniBatchKMeans } from '../dependencies/sklearn-kmeans.ts';
import type { EncoderProtocol } from '../models/models-protocols.ts';
import type { TimingStack } from '../timing.ts';
import type { Embeddings, EncodeKwargs } from '../types/encoder-io.ts';
import { Evaluator } from './evaluator.ts';

// mteb/_evaluators/clustering_evaluator.py, for text. Python's __call__ is
// call().

// Encodes the inputs, then clusters the embeddings with MiniBatchKMeans into
// as many clusters as there are labels, and gives the cluster of each input.
export class ClusteringEvaluator extends Evaluator {
  readonly dataset: Dataset;
  readonly clusteringBatchSize: number;
  readonly inputColumnName: string;
  readonly labelColumnName: string;
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
  readonly timer: TimingStack;

  constructor(
    dataset: Dataset,
    options: {
      readonly inputColumnName: string;
      readonly labelColumnName: string;
      readonly taskMetadata: TaskMetadata;
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly clusteringBatchSize?: number;
      readonly timer: TimingStack;
      readonly seed?: number;
    },
  ) {
    super(options);
    this.dataset = dataset;
    this.clusteringBatchSize = options.clusteringBatchSize ?? 500;
    this.inputColumnName = options.inputColumnName;
    this.labelColumnName = options.labelColumnName;
    this.taskMetadata = options.taskMetadata;
    this.hfSplit = options.hfSplit;
    this.hfSubset = options.hfSubset;
    this.timer = options.timer;
  }

  async call(
    model: EncoderProtocol,
    encodeKwargs: EncodeKwargs,
  ): Promise<number[]> {
    const { modalities } = this.taskMetadata;
    if (modalities.length !== 1 || modalities[0] !== 'text')
      throw new Error(
        `The ${modalities.join(', ')} modality is not supported yet.`,
      );
    const location = { split: this.hfSplit, subset: this.hfSubset };
    let embeddings: Embeddings;
    {
      using _ = this.timer.phase('Encoding', location);
      embeddings = await model.encode(
        createDataloaderFromTexts(
          this.dataset.rows.map((row) => String(row[this.inputColumnName])),
          { batchSize: encodeKwargs.batchSize ?? 32 },
        ),
        {
          ...encodeKwargs,
          taskMetadata: this.taskMetadata,
          hfSplit: this.hfSplit,
          hfSubset: this.hfSubset,
          promptType: null,
        },
      );
    }
    const labels = this.dataset.rows.map((row) => row[this.labelColumnName]);
    using _ = this.timer.phase('Scoring', location);
    const clusteringModel = new MiniBatchKMeans({
      nClusters: new Set(labels).size,
      batchSize: this.clusteringBatchSize,
      nInit: 'auto',
      randomState: this.seed,
    });
    return clusteringModel.fit(embeddings).labels;
  }
}
