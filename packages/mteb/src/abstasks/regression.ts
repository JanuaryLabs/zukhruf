import { trainTestSplit } from '../dependencies/datasets-train-test-split.ts';
import type { Dataset } from '../dependencies/datasets.ts';
import { qcut } from '../dependencies/pandas.ts';
import { kendalltau } from '../dependencies/scipy.ts';
import { LinearRegression } from '../dependencies/sklearn-linear-regression.ts';
import {
  meanAbsoluteError,
  meanSquaredError,
  r2Score,
} from '../dependencies/sklearn.ts';
import {
  type RegressorModel,
  valuesOf,
} from '../evaluators/sklearn-evaluator.ts';
import { SklearnEvaluatorTask, type Undersampling } from './classification.ts';

// mteb/abstasks/regression.py, for text. The descriptive statistics, the
// push to the Hub and the cross validation are not ported.

// The scores of one experiment, in the order of MTEB's dict.
export type RegressionMetrics = {
  readonly mse: number;
  readonly mae: number;
  readonly r2: number;
  readonly kendalltau: number;
  readonly rmse: number;
};

// A regression task: an evaluator model (LinearRegression) learns the values
// from the embeddings of the training rows, then predicts the values of the
// evaluation split. The task runs nExperiments experiments and reports the
// mean of their scores. A training split of more than nSamples rows keeps
// nSamples of them in each experiment, by a stratified subsampling over the
// deciles of the values with the seed of the task plus the number of the
// experiment.
export abstract class AbsTaskRegression extends SklearnEvaluatorTask<
  number,
  Float32Array,
  RegressionMetrics
> {
  evaluatorModel: RegressorModel = new LinearRegression();
  override labelColumnName = 'value';
  nSamples = 2048;

  override get abstaskPrompt(): string {
    return 'Predict the value of the user passage.';
  }

  protected targetsOf(dataset: Dataset, column: string): number[] {
    return valuesOf(dataset, column);
  }

  // _undersample_data: all the rows when there are at most nSamples, else
  // the rows of the stratified subsampling of experiment experimentNum, in
  // the order of the subsampling. The indices of the previous experiment are
  // not read, and the next experiment gets none.
  protected undersampleData(
    dataset: Dataset,
    experimentNum: number,
    _idxs: readonly number[] | null,
  ): Undersampling {
    if (this.nSamples >= dataset.rows.length)
      return { idxs: [], selected: dataset.rows.map((_, index) => index) };
    const indexed = {
      columnNames: [...dataset.columnNames, '__idx__'],
      rows: dataset.rows.map((row, index) => ({ ...row, __idx__: index })),
    };
    const subsampled = AbsTaskRegression.stratifiedSubsampling(
      new Map([['train', indexed]]),
      {
        seed: this.seed + experimentNum,
        splits: ['train'],
        label: this.labelColumnName,
        nSamples: this.nSamples,
      },
    ).get('train');
    if (subsampled === undefined) throw new Error("KeyError: 'train'");
    return { idxs: [], selected: valuesOf(subsampled, '__idx__') };
  }

  protected calculateScores(
    yTest: readonly number[],
    yPred: Float32Array,
  ): RegressionMetrics {
    const mse = meanSquaredError(yTest, yPred);
    return {
      mse,
      mae: meanAbsoluteError(yTest, yPred),
      r2: r2Score(yTest, yPred),
      kendalltau: kendalltau(yTest, yPred),
      rmse: Math.sqrt(mse),
    };
  }

  // stratified_subsampling: each split of splits with more than nSamples
  // rows keeps nSamples of them, the test side of a train_test_split
  // stratified by the bins of qcut(label, nBins). It changes datasetDict and
  // returns it, as MTEB does. A label of one value gives NaN bins, which
  // pyarrow refuses as class ids.
  static stratifiedSubsampling(
    datasetDict: Map<string, Dataset>,
    options: {
      readonly seed: number;
      readonly splits?: readonly string[];
      readonly label?: string;
      readonly nSamples?: number;
      readonly nBins?: number;
    },
  ): Map<string, Dataset> {
    const {
      seed,
      splits = ['test'],
      label = 'value',
      nSamples = 2048,
      nBins = 10,
    } = options;
    const stratifyColName = `${label}_binned_for_stratification`;
    for (const split of splits) {
      const dataset = datasetDict.get(split);
      if (dataset === undefined) throw new Error(`KeyError: '${split}'`);
      if (nSamples >= dataset.rows.length) continue;
      const binned = qcut(valuesOf(dataset, label), nBins, {
        labels: false,
        duplicates: 'drop',
      });
      if (binned.some(Number.isNaN))
        throw new Error('Float value nan was truncated converting to int64');
      const withBins = {
        columnNames: [...dataset.columnNames, stratifyColName],
        rows: dataset.rows.map((row, index) => ({
          ...row,
          [stratifyColName]: binned[index] ?? Number.NaN,
        })),
      };
      const subsampled = trainTestSplit(withBins, {
        testSize: nSamples,
        seed,
        stratifyByColumn: stratifyColName,
      }).get('test');
      if (subsampled === undefined) throw new Error("KeyError: 'test'");
      datasetDict.set(split, {
        columnNames: dataset.columnNames,
        rows: subsampled.rows.map(({ [stratifyColName]: _bin, ...row }) => row),
      });
    }
    return datasetDict;
  }
}
