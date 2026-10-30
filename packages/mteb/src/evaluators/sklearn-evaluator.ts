import type { Dataset, DatasetValue } from '../dependencies/datasets.ts';
import type { ClassLabel } from '../dependencies/sklearn.ts';
import type { TimingStack } from '../timing.ts';
import type { Embeddings } from '../types/encoder-io.ts';
import { Evaluator } from './evaluator.ts';

// mteb/_evaluators/sklearn_evaluator.py. Python's __call__ is call().

// SklearnModelProtocol: a model that learns targets (Y) from embeddings and
// predicts them (P), as LogisticRegression and LinearRegression do.
export type SklearnModel<Y, P> = {
  fit(x: Embeddings, y: readonly Y[]): { predict(x: Embeddings): P };
};

// A model that learns labels and predicts them.
export type ClassifierModel = SklearnModel<ClassLabel, ClassLabel[]>;

// A model that learns values and predicts them in float32.
export type RegressorModel = SklearnModel<number, Float32Array>;

// Fits the evaluator model on the training embeddings and their targets,
// then predicts the targets of the evaluation embeddings. targetsOf reads
// the targets of a split, because the values of a row have no type.
export class SklearnEvaluator<Y, P> extends Evaluator {
  readonly trainDataset: Dataset;
  readonly evalDataset: Dataset;
  readonly labelColumnName: string;
  readonly evaluatorModel: SklearnModel<Y, P>;
  readonly targetsOf: (dataset: Dataset, column: string) => Y[];
  readonly timer: TimingStack;

  constructor(
    trainDataset: Dataset,
    evalDataset: Dataset,
    options: {
      readonly labelColumnName: string;
      readonly evaluatorModel: SklearnModel<Y, P>;
      readonly targetsOf: (dataset: Dataset, column: string) => Y[];
      readonly timer: TimingStack;
      readonly seed?: number;
    },
  ) {
    super(options);
    this.trainDataset = trainDataset;
    this.evalDataset = evalDataset;
    this.labelColumnName = options.labelColumnName;
    this.evaluatorModel = options.evaluatorModel;
    this.targetsOf = options.targetsOf;
    this.timer = options.timer;
  }

  call(trainEmbeddings: Embeddings, testEmbeddings: Embeddings): P {
    const yTrain = this.targetsOf(this.trainDataset, this.labelColumnName);
    return this.evaluatorModel
      .fit(trainEmbeddings, yTrain)
      .predict(testEmbeddings);
  }
}

// The values of a split, for a regression task: a number each.
export function valuesOf(dataset: Dataset, column: string): number[] {
  return dataset.rows.map((row) => {
    const value = row[column];
    if (typeof value !== 'number')
      throw new TypeError(`A value must be a number, not ${String(value)}.`);
    return value;
  });
}

// The labels of a split: an int or a string each.
export function labelsOf(dataset: Dataset, column: string): ClassLabel[] {
  return dataset.rows.map((row) => classLabel(row[column]));
}

// The label sets of a split, for a multilabel task: a list of labels each.
export function labelSetsOf(dataset: Dataset, column: string): ClassLabel[][] {
  return dataset.rows.map((row) => {
    const value = row[column];
    if (!Array.isArray(value))
      throw new TypeError(
        `A multilabel label must be a list of labels, not ${String(value)}.`,
      );
    return value.map((label: DatasetValue) => classLabel(label));
  });
}

function classLabel(value: DatasetValue | undefined): ClassLabel {
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new TypeError(
    `A label must be an int or a string, not ${String(value)}.`,
  );
}
