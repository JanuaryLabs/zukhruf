import type { TaskMetadata } from '../abstasks/task-metadata.ts';
import { createDataloaderFromTexts } from '../create-dataloaders.ts';
import type { Dataset } from '../dependencies/datasets.ts';
import {
  pairedCosineDistances,
  pairedEuclideanDistances,
  pairedManhattanDistances,
} from '../dependencies/sklearn.ts';
import type { EncoderProtocol } from '../models/models-protocols.ts';
import type { TimingStack } from '../timing.ts';
import type {
  Embeddings,
  EncodeKwargs,
  PromptType,
} from '../types/encoder-io.ts';
import { Evaluator } from './evaluator.ts';

// mteb/_evaluators/pair_classification_evaluator.py, for text. Python's
// __call__ is call(). _encode_unique_texts has no caller in MTEB and is not
// ported.

// The scores of each pair: float32 values, as Python's tolist gives them.
export type PairClassificationDistances = {
  readonly cosineScores: number[];
  readonly euclideanDistances: number[];
  readonly manhattanDistances: number[];
  readonly similarityScores: number[];
  readonly dotScores: number[];
};

// Encodes the first and the second input of each pair, then scores each
// pair with the cosine similarity, the Euclidean and Manhattan distances,
// the similarity of the model and the dot product.
export class PairClassificationEvaluator extends Evaluator {
  readonly dataset: Dataset;
  readonly input1ColumnName: string;
  readonly input2ColumnName: string;
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
  readonly input1PromptType: PromptType | null;
  readonly input2PromptType: PromptType | null;
  readonly timer: TimingStack;

  constructor(
    dataset: Dataset,
    options: {
      readonly input1ColumnName: string;
      readonly input2ColumnName: string;
      readonly taskMetadata: TaskMetadata;
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly input1PromptType: PromptType | null;
      readonly input2PromptType: PromptType | null;
      readonly timer: TimingStack;
      readonly seed?: number;
    },
  ) {
    super(options);
    this.dataset = dataset;
    this.input1ColumnName = options.input1ColumnName;
    this.input2ColumnName = options.input2ColumnName;
    this.taskMetadata = options.taskMetadata;
    this.hfSplit = options.hfSplit;
    this.hfSubset = options.hfSubset;
    this.input1PromptType = options.input1PromptType;
    this.input2PromptType = options.input2PromptType;
    this.timer = options.timer;
  }

  async call(
    model: EncoderProtocol,
    encodeKwargs: EncodeKwargs,
  ): Promise<PairClassificationDistances> {
    let embeddings1: Embeddings;
    {
      using _ = this.timer.phase('Encoding samples 1', this.#location());
      embeddings1 = await this.#encode(
        model,
        this.input1ColumnName,
        this.input1PromptType,
        encodeKwargs,
      );
    }
    let embeddings2: Embeddings;
    {
      using _ = this.timer.phase('Encoding samples 2', this.#location());
      embeddings2 = await this.#encode(
        model,
        this.input2ColumnName,
        this.input2PromptType,
        encodeKwargs,
      );
    }
    using _ = this.timer.phase('Scoring', this.#location());
    const cosineScores = pairedCosineDistances(embeddings1, embeddings2).map(
      (distance) => 1 - distance,
    );
    const manhattanDistances = pairedManhattanDistances(
      embeddings1,
      embeddings2,
    );
    const euclideanDistances = pairedEuclideanDistances(
      embeddings1,
      embeddings2,
    );
    // compute_pairwise_similarity: every encoder here has similarityPairwise.
    const similarityScores = model.similarityPairwise(embeddings1, embeddings2);
    // np.dot of each pair of float32 rows. numpy calls BLAS sdot, whose
    // order of addition this port does not copy: each product here is the
    // float32 nearest to the float64 sum.
    const dotScores = Float32Array.from(embeddings1, (row, index) => {
      const other = embeddings2[index] ?? new Float32Array(row.length);
      let total = 0;
      for (let column = 0; column < row.length; column++)
        total += (row[column] ?? 0) * (other[column] ?? 0);
      return total;
    });
    return {
      cosineScores: [...cosineScores],
      euclideanDistances: [...euclideanDistances],
      manhattanDistances: [...manhattanDistances],
      similarityScores: [...similarityScores],
      dotScores: [...dotScores],
    };
  }

  #location(): { readonly split: string; readonly subset: string } {
    return { split: this.hfSplit, subset: this.hfSubset };
  }

  // The column becomes the column of the modality, and create_dataloader
  // gives a dataloader of its texts: the prompt type is None and the task
  // has the text modality only. Other modalities are not ported.
  async #encode(
    model: EncoderProtocol,
    column: string,
    promptType: PromptType | null,
    encodeKwargs: EncodeKwargs,
  ): Promise<Embeddings> {
    const { modalities } = this.taskMetadata;
    if (modalities.length !== 1 || modalities[0] !== 'text')
      throw new Error(
        `The ${modalities.join(', ')} modality is not supported yet.`,
      );
    if (!this.dataset.columnNames.includes(column))
      throw new Error(
        `Column name ['${column}'] not in the dataset. Current columns in the dataset: [${this.dataset.columnNames.map((name) => `'${name}'`).join(', ')}].`,
      );
    return model.encode(
      createDataloaderFromTexts(
        this.dataset.rows.map((row) => String(row[column])),
        { batchSize: encodeKwargs.batchSize ?? 32 },
      ),
      {
        ...encodeKwargs,
        taskMetadata: this.taskMetadata,
        hfSplit: this.hfSplit,
        hfSubset: this.hfSubset,
        promptType,
      },
    );
  }
}
