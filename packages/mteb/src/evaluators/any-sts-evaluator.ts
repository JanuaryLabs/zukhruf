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

// mteb/_evaluators/any_sts_evaluator.py, for text. Python's __call__ is
// call().

// The scores of each pair: float32 values, as Python's tolist gives them.
// The distances are negated, so that a higher score is a more similar pair.
export type STSEvaluatorScores = {
  readonly cosineScores: number[];
  readonly manhattanDistances: number[];
  readonly euclideanDistances: number[];
  readonly similarityScores: number[];
};

// Encodes the first and the second input of each pair, then scores each
// pair with the cosine similarity, the negated Manhattan and Euclidean
// distances and the similarity of the model.
export class AnySTSEvaluator extends Evaluator {
  readonly dataset: Dataset;
  readonly inputColumns: readonly [string, string];
  readonly taskMetadata: TaskMetadata;
  readonly hfSplit: string;
  readonly hfSubset: string;
  readonly input1PromptType: PromptType | null;
  readonly input2PromptType: PromptType | null;
  readonly timer: TimingStack;

  constructor(
    dataset: Dataset,
    sentencesColumnNames: readonly [string, string],
    options: {
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
    this.inputColumns = sentencesColumnNames;
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
  ): Promise<STSEvaluatorScores> {
    let embeddings1: Embeddings;
    {
      using _ = this.timer.phase('Encoding samples 1', this.#location());
      embeddings1 = await this.#encode(
        model,
        this.inputColumns[0],
        this.input1PromptType,
        encodeKwargs,
      );
    }
    let embeddings2: Embeddings;
    {
      using _ = this.timer.phase('Encoding samples 2', this.#location());
      embeddings2 = await this.#encode(
        model,
        this.inputColumns[1],
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
    ).map((distance) => -distance);
    const euclideanDistances = pairedEuclideanDistances(
      embeddings1,
      embeddings2,
    ).map((distance) => -distance);
    // compute_pairwise_similarity: every encoder here has similarityPairwise.
    const similarityScores = model.similarityPairwise(embeddings1, embeddings2);
    return {
      cosineScores: [...cosineScores],
      manhattanDistances: [...manhattanDistances],
      euclideanDistances: [...euclideanDistances],
      similarityScores: [...similarityScores],
    };
  }

  #location(): { readonly split: string; readonly subset: string } {
    return { split: this.hfSplit, subset: this.hfSubset };
  }

  // The column becomes the column of the modality, and create_dataloader
  // gives a dataloader of its texts. Other modalities and a mapping of
  // columns to modalities are not ported.
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
