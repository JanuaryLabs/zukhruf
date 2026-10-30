import type { Dataset, DatasetValue } from '../dependencies/datasets.ts';
import type { ClassLabel } from '../dependencies/sklearn.ts';
import type { TimingStack } from '../timing.ts';
import type { Embeddings } from '../types/encoder-io.ts';
import { Evaluator } from './evaluator.ts';

// mteb/_evaluators/sklearn_evaluator.py. Python's __call__ is call().

// SklearnModelProtocol: a model that learns labels from embeddings and
// predicts them, as LogisticRegression does.
export type ClassifierModel = {
  fit(
    x: Embeddings,
    y: readonly ClassLabel[],
  ): { predict(x: Embeddings): ClassLabel[] };
};

// Fits the evaluator model on the training embeddings and their labels,
// then predicts the labels of the evaluation embeddings.
export class SklearnEvaluator extends Evaluator {
  readonly trainDataset: Dataset;
  readonly evalDataset: Dataset;
  readonly labelColumnName: string;
  readonly evaluatorModel: ClassifierModel;
  readonly timer: TimingStack;

  constructor(
    trainDataset: Dataset,
    evalDataset: Dataset,
    options: {
      readonly labelColumnName: string;
      readonly evaluatorModel: ClassifierModel;
      readonly timer: TimingStack;
      readonly seed?: number;
    },
  ) {
    super(options);
    this.trainDataset = trainDataset;
    this.evalDataset = evalDataset;
    this.labelColumnName = options.labelColumnName;
    this.evaluatorModel = options.evaluatorModel;
    this.timer = options.timer;
  }

  call(trainEmbeddings: Embeddings, testEmbeddings: Embeddings): ClassLabel[] {
    const yTrain = labelsOf(this.trainDataset, this.labelColumnName);
    return this.evaluatorModel
      .fit(trainEmbeddings, yTrain)
      .predict(testEmbeddings);
  }
}

// The labels of a split: an int or a string each.
export function labelsOf(dataset: Dataset, column: string): ClassLabel[] {
  return dataset.rows.map((row) => classLabel(row[column]));
}

function classLabel(value: DatasetValue | undefined): ClassLabel {
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new TypeError(
    `A label must be an int or a string, not ${String(value)}.`,
  );
}
