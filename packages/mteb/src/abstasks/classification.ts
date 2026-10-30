import { createDataloaderFromTexts } from '../create-dataloaders.ts';
import { type Dataset, select } from '../dependencies/datasets.ts';
import { RandomState } from '../dependencies/numpy-random.ts';
import { mean } from '../dependencies/numpy.ts';
import { LogisticRegression } from '../dependencies/sklearn-logistic.ts';
import {
  type ClassLabel,
  accuracyScore,
  averagePrecisionScore,
  f1Score,
  precisionScore,
  recallScore,
} from '../dependencies/sklearn.ts';
import {
  type ClassifierModel,
  SklearnEvaluator,
  labelsOf,
} from '../evaluators/sklearn-evaluator.ts';
import { type EncoderProtocol, isEncoder } from '../models/models-protocols.ts';
import type { TimingStack } from '../timing.ts';
import type { Embeddings, EncodeKwargs } from '../types/encoder-io.ts';
import type { Score } from '../types/result.ts';
import { AbsTask, type MTEBModels } from './abstask.ts';

// mteb/abstasks/classification.py, for text. The cross validation
// (is_cross_validation), the descriptive statistics and the push to the Hub
// are not ported. MTEB sets random_state=seed on the evaluator model; the
// lbfgs solver of LogisticRegression draws no random numbers, so the port
// has no random state to set.

// The scores of one experiment. ap and ap_weighted are null unless the
// evaluation labels have two classes.
export type ClassificationMetrics = {
  readonly accuracy: number;
  readonly f1: number;
  readonly f1_weighted: number;
  readonly precision: number;
  readonly precision_weighted: number;
  readonly recall: number;
  readonly recall_weighted: number;
  readonly ap: number | null;
  readonly ap_weighted: number | null;
};

// The keys of ClassificationMetrics, in the order of MTEB's dict.
const METRIC_NAMES = [
  'accuracy',
  'f1',
  'f1_weighted',
  'precision',
  'precision_weighted',
  'recall',
  'recall_weighted',
  'ap',
  'ap_weighted',
] as const satisfies readonly (keyof ClassificationMetrics)[];

// An experiment's training rows: the shuffled indices that the next
// experiment shuffles again, and the indices that it selected.
export type Undersampling = {
  readonly idxs: number[];
  readonly selected: number[];
};

// What AbsTaskClassification and AbsTaskMultilabelClassification share: the
// fields of the training rows, the prompt, the loading of the data, and the
// checks of evaluate. In Python the multilabel task subclasses
// AbsTaskClassification and replaces its evaluator model with one of another
// type; here each task type declares its own evaluator model.
export abstract class ClassificationTaskBase extends AbsTask<Dataset> {
  samplesPerLabel = 8;
  nExperiments = 10;
  trainSplit = 'train';
  labelColumnName = 'label';
  inputColumnName = 'text';

  override get abstaskPrompt(): string {
    return 'Classify user passages.';
  }

  protected override loadSplits() {
    return this.loadDatasets();
  }

  // The checks of evaluate for a subset, then its training split.
  protected trainSplitOf(
    model: MTEBModels,
    hfSubset: string,
  ): { readonly model: EncoderProtocol; readonly trainSplit: Dataset } {
    if (!isEncoder(model))
      throw new TypeError(
        'Expected model to be an instance of EncoderProtocol',
      );
    const splits = this.dataset?.get(hfSubset);
    const available = splits?.values().next().value?.columnNames ?? [];
    const missing = [this.inputColumnName, this.labelColumnName].filter(
      (column) => !available.includes(column),
    );
    if (missing.length > 0)
      throw new Error(
        `Missing required columns in dataset: ${missing.join(', ')}. Available columns: ${available.join(', ')}`,
      );
    const trainSplit = splits?.get(this.trainSplit);
    if (trainSplit === undefined)
      throw new Error(`KeyError: '${this.trainSplit}'`);
    const { modalities } = this.metadata;
    if (modalities.length !== 1 || modalities[0] !== 'text')
      throw new Error(
        `The ${modalities.join(', ')} modality is not supported yet.`,
      );
    return { model, trainSplit };
  }
}

// A classification task: an evaluator model (LogisticRegression) learns the
// labels from the embeddings of samplesPerLabel training rows of each label,
// then predicts the labels of the evaluation split. The task runs
// nExperiments experiments on other training rows and reports the mean of
// their scores.
export abstract class AbsTaskClassification extends ClassificationTaskBase {
  evaluatorModel: ClassifierModel = new LogisticRegression({ maxIter: 100 });

  protected override async evaluateSubset(
    mtebModel: MTEBModels,
    evalSplit: Dataset,
    options: {
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly encodeKwargs: EncodeKwargs;
      readonly predictionFolder: string | null;
      readonly timer: TimingStack;
    },
  ): Promise<Record<string, Score>> {
    const { hfSplit, hfSubset, encodeKwargs, timer } = options;
    const { model, trainSplit } = this.trainSplitOf(mtebModel, hfSubset);

    const allSelectedIdxs = this.undersampleExperiments(trainSplit).map(
      ({ selected }) => selected,
    );
    const unionIdxs = [...new Set(allSelectedIdxs.flat())].sort(
      (a, b) => a - b,
    );
    const encode = (rows: readonly Dataset['rows'][number][], split: string) =>
      model.encode(
        createDataloaderFromTexts(
          rows.map((row) => String(row[this.inputColumnName])),
          { batchSize: encodeKwargs.batchSize ?? 32 },
        ),
        {
          ...encodeKwargs,
          taskMetadata: this.metadata,
          hfSplit: split,
          hfSubset,
          promptType: null,
        },
      );
    const location = { split: hfSplit, subset: hfSubset };
    let unionCache: Embeddings;
    {
      using _ = timer.phase('Encoding training samples', location);
      unionCache = await encode(
        select(trainSplit, unionIdxs).rows,
        this.trainSplit,
      );
    }
    const idxToPos = new Map(unionIdxs.map((index, pos) => [index, pos]));
    let testEmbeddings: Embeddings;
    {
      using _ = timer.phase('Encoding test samples', location);
      testEmbeddings = await encode(evalSplit.rows, hfSplit);
    }

    const scores: ClassificationMetrics[] = [];
    const allPredictions: ClassLabel[][] = [];
    {
      using _ = timer.phase('Scoring', location);
      for (const [i, selected] of allSelectedIdxs.entries()) {
        const trainEmbeddings = selected.map(
          (index) => unionCache[idxToPos.get(index) ?? 0] ?? new Float32Array(),
        );
        using _experiment = timer.phase(
          `Running experiment (${i}/${this.nExperiments})`,
          location,
        );
        const [scoresExp, predictions] = this.runExperiment(
          select(trainSplit, selected),
          evalSplit,
          trainEmbeddings,
          testEmbeddings,
          timer,
        );
        if (options.predictionFolder !== null) allPredictions.push(predictions);
        scores.push(scoresExp);
      }
    }
    if (options.predictionFolder !== null)
      this.saveTaskPredictions(
        allPredictions,
        model,
        options.predictionFolder,
        hfSplit,
        hfSubset,
      );
    return this.calculateAvgScores(scores);
  }

  protected runExperiment(
    trainSplit: Dataset,
    evalSplit: Dataset,
    trainEmbeddings: Embeddings,
    testEmbeddings: Embeddings,
    timer: TimingStack,
  ): [ClassificationMetrics, ClassLabel[]] {
    const evaluator = new SklearnEvaluator(trainSplit, evalSplit, {
      labelColumnName: this.labelColumnName,
      evaluatorModel: this.evaluatorModel,
      timer,
    });
    const yPred = evaluator.call(trainEmbeddings, testEmbeddings);
    const yTest = labelsOf(evalSplit, this.labelColumnName);
    return [this.calculateScores(yTest, yPred), yPred];
  }

  // The mean of each score over the experiments, NaN where no experiment
  // has the score, after the scores of each experiment.
  protected calculateAvgScores(
    scores: readonly ClassificationMetrics[],
  ): Record<string, Score> {
    const average: Record<string, number> = {};
    for (const key of METRIC_NAMES) {
      const values = scores
        .map((score) => score[key])
        .filter((value) => value !== null);
      average[key] = values.length > 0 ? mean(values) : Number.NaN;
    }
    return { scores_per_experiment: scores, ...average };
  }

  protected calculateScores(
    yTest: readonly ClassLabel[],
    yPred: readonly ClassLabel[],
  ): ClassificationMetrics {
    const binary = new Set(yTest).size === 2;
    const ap = binary ? averagePrecision(yTest, yPred) : null;
    return {
      accuracy: accuracyScore(yTest, yPred),
      f1: f1Score(yTest, yPred, 'macro'),
      f1_weighted: f1Score(yTest, yPred, 'weighted'),
      precision: precisionScore(yTest, yPred, 'macro'),
      precision_weighted: precisionScore(yTest, yPred, 'weighted'),
      recall: recallScore(yTest, yPred, 'macro'),
      recall_weighted: recallScore(yTest, yPred, 'weighted'),
      // For binary labels, scikit-learn ignores the average.
      ap,
      ap_weighted: ap,
    };
  }

  // The undersampling of each experiment, as MTEB simulates them all
  // before it encodes: each one shuffles the indices that the previous one
  // shuffled.
  protected undersampleExperiments(trainSplit: Dataset): Undersampling[] {
    const experiments: Undersampling[] = [];
    let idxs: readonly number[] | null = null;
    for (let i = 0; i < this.nExperiments; i++) {
      const undersampling = this.undersampleData(trainSplit, idxs);
      idxs = undersampling.idxs;
      experiments.push(undersampling);
    }
    return experiments;
  }

  // _undersample_data: samplesPerLabel rows of each label, in the order of
  // idxs shuffled by a new RandomState(seed). The next experiment shuffles
  // the shuffled idxs again, from the same seed.
  // MTEB also passes the number of the experiment, which it does not read.
  protected undersampleData(
    dataset: Dataset,
    idxs: readonly number[] | null = null,
  ): Undersampling {
    const shuffled =
      idxs === null ? dataset.rows.map((_, index) => index) : [...idxs];
    new RandomState(this.seed).shuffle(shuffled);
    const labelCounter = new Map<ClassLabel, number>();
    const selected: number[] = [];
    const labels = labelsOf(dataset, this.labelColumnName);
    for (const i of shuffled) {
      const label = labels[i] ?? 0;
      const count = labelCounter.get(label) ?? 0;
      if (count < this.samplesPerLabel) {
        selected.push(i);
        labelCounter.set(label, count + 1);
      }
    }
    return { idxs: shuffled, selected };
  }
}

// average_precision_score(y_true, y_pred) of binary labels, with the
// predicted labels as scores. pos_label 1 must be a label.
function averagePrecision(
  yTest: readonly ClassLabel[],
  yPred: readonly ClassLabel[],
): number {
  const numbers = (labels: readonly ClassLabel[]) =>
    labels.map((label) => {
      if (typeof label === 'number') return label;
      throw new Error(
        `pos_label=1 is not a valid label. It should be one of [${[
          ...new Set(yTest),
        ]
          .sort()
          .map((value) => `'${value}'`)
          .join(', ')}]`,
      );
    });
  return averagePrecisionScore(numbers(yTest), numbers(yPred));
}
