import { createDataloaderFromTexts } from '../create-dataloaders.ts';
import { type Dataset, select } from '../dependencies/datasets.ts';
import { NumpyGenerator } from '../dependencies/numpy-random.ts';
import { mean } from '../dependencies/numpy.ts';
import { pythonIntSetOrder } from '../dependencies/python-set.ts';
import { KNeighborsClassifier } from '../dependencies/sklearn-neighbors.ts';
import {
  type ClassLabel,
  type LabelIndicator,
  MultiLabelBinarizer,
  f1Score,
  labelRankingAveragePrecisionScore,
} from '../dependencies/sklearn.ts';
import { hammingScore } from '../evaluators/classification-metrics.ts';
import { labelSetsOf } from '../evaluators/sklearn-evaluator.ts';
import type { TimingStack } from '../timing.ts';
import type { Embeddings, EncodeKwargs } from '../types/encoder-io.ts';
import type { Score } from '../types/result.ts';
import { type MTEBModels, multilabelSubsampling } from './abstask.ts';
import { ClassificationTaskBase } from './classification.ts';

// mteb/abstasks/multilabel_classification.py, for text. The scores of an
// evaluator model that is a MultiOutputClassifier (LRAP of predict_proba)
// are not ported: MTEB's evaluator model is a KNeighborsClassifier.

// The scores of one experiment, in the order of MTEB's dict.
export type MultilabelClassificationMetrics = {
  readonly accuracy: number;
  readonly lrap: number;
  readonly f1: number;
  readonly hamming: number;
};

// The keys of MultilabelClassificationMetrics, in the order of MTEB's dict.
const METRIC_NAMES = [
  'accuracy',
  'lrap',
  'f1',
  'hamming',
] as const satisfies readonly (keyof MultilabelClassificationMetrics)[];

// SklearnModelProtocol for label indicator matrices: a model that learns the
// labels of each row from the embeddings, then predicts them and scores its
// predictions, as KNeighborsClassifier does.
export type MultilabelClassifierModel = {
  fit(
    x: Embeddings,
    y: LabelIndicator,
  ): {
    predict(x: Embeddings): number[][];
    score(x: Embeddings, y: LabelIndicator): number;
  };
};

// An experiment's training rows: the indices that it selected, and all the
// indices in the order of the shuffle.
export type MultilabelUndersampling = {
  readonly sampleIndices: number[];
  readonly idxs: number[];
};

// A multilabel classification task: each row has a list of labels. An
// evaluator model (KNeighborsClassifier with 5 neighbours) learns the labels
// from the embeddings of training rows until each label has samplesPerLabel
// rows, then predicts the labels of the evaluation split. The task runs
// nExperiments experiments and reports the mean of their scores. An
// evaluation split of more than maxEvalSamples rows keeps maxEvalSamples of
// them by iterative stratification.
export abstract class AbsTaskMultilabelClassification extends ClassificationTaskBase {
  evaluatorModel: MultilabelClassifierModel = new KNeighborsClassifier({
    nNeighbors: 5,
  });
  samplesPerLabel = 8;
  maxEvalSamples: number | null = 3000;
  // np_rng of AbsTask: default_rng(seed), made with the task. The shuffles of
  // every evaluation of the task draw from it in turn.
  readonly npRng = new NumpyGenerator(this.seed);

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
    const trainLabels = labelSetsOf(trainSplit, this.labelColumnName);
    const trainSamples = Array.from(
      { length: this.nExperiments },
      () =>
        this.undersampleDataIndices(trainLabels, this.samplesPerLabel)
          .sampleIndices,
    );
    const uniqueTrainIndices = pythonIntSetOrder(trainSamples.flat());
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
    let uniqueTrainEmbeddings: Embeddings;
    {
      using _ = timer.phase('Encoding training samples', location);
      uniqueTrainEmbeddings = await encode(
        select(trainSplit, uniqueTrainIndices).rows,
        this.trainSplit,
      );
    }
    const embeddingOf = new Map(
      uniqueTrainIndices.map((index, position) => [
        index,
        uniqueTrainEmbeddings[position] ?? new Float32Array(),
      ]),
    );
    let testDataset = evalSplit;
    if (
      this.maxEvalSamples !== null &&
      evalSplit.rows.length > this.maxEvalSamples
    )
      testDataset =
        multilabelSubsampling(
          new Map([[hfSplit, evalSplit]]),
          this.seed,
          [hfSplit],
          this.labelColumnName,
          this.maxEvalSamples,
        ).get(hfSplit) ?? evalSplit;
    let xTest: Embeddings;
    {
      using _ = timer.phase('Encoding test samples', location);
      xTest = await encode(testDataset.rows, hfSplit);
    }
    const binarizer = new MultiLabelBinarizer();
    const yTest = binarizer.fitTransform(
      labelSetsOf(testDataset, this.labelColumnName),
    );

    const scores: MultilabelClassificationMetrics[] = [];
    const allPredictions: number[][][] = [];
    {
      using _ = timer.phase('Scoring', location);
      for (const [i, sampleIndices] of trainSamples.entries()) {
        using _experiment = timer.phase(
          `Running experiment (${i}/${this.nExperiments})`,
          location,
        );
        const xTrain = sampleIndices.map(
          (index) => embeddingOf.get(index) ?? new Float32Array(),
        );
        const yTrain = binarizer.transform(
          sampleIndices.map((index) => trainLabels[index] ?? []),
        );
        const classifier = this.evaluatorModel.fit(xTrain, yTrain);
        const yPred = classifier.predict(xTest);
        if (options.predictionFolder !== null) allPredictions.push(yPred);
        scores.push(this.calculateScores(yTest, yPred, xTest, classifier));
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
    // MTEB averages the keys of the first experiment's scores.
    if (scores.length === 0)
      throw new Error('IndexError: list index out of range');
    const average: Record<string, number> = {};
    for (const key of METRIC_NAMES)
      average[key] = mean(scores.map((score) => score[key]));
    return { scores_per_experiment: scores, ...average };
  }

  protected calculateScores(
    yTest: LabelIndicator,
    yPred: LabelIndicator,
    xTest: Embeddings,
    classifier: { score(x: Embeddings, y: LabelIndicator): number },
  ): MultilabelClassificationMetrics {
    const accuracy = classifier.score(xTest, yTest);
    // With one label, scikit-learn fits a single output and predicts a 1-D
    // array, and label_ranking_average_precision_score raises.
    if ((yTest[0]?.length ?? 0) === 1)
      throw new Error('y_true and y_score have different shape');
    return {
      accuracy,
      lrap: labelRankingAveragePrecisionScore(yTest, yPred),
      f1: f1Score(yTest, yPred, 'macro'),
      hamming: hammingScore(yTest, yPred),
    };
  }

  // _undersample_data_indices: npRng shuffles idxs (all the indices when
  // null), then the task takes each row with a label that has fewer than
  // samplesPerLabel rows yet. A row without labels is never taken.
  protected undersampleDataIndices(
    y: readonly (readonly ClassLabel[])[],
    samplesPerLabel: number,
    idxs: number[] | null = null,
  ): MultilabelUndersampling {
    const shuffled = idxs ?? y.map((_, index) => index);
    this.npRng.shuffle(shuffled);
    const labelCounter = new Map<ClassLabel, number>();
    const sampleIndices: number[] = [];
    for (const i of shuffled) {
      const labels = y[i] ?? [];
      if (
        labels.some((label) => (labelCounter.get(label) ?? 0) < samplesPerLabel)
      ) {
        sampleIndices.push(i);
        for (const label of labels)
          labelCounter.set(label, (labelCounter.get(label) ?? 0) + 1);
      }
    }
    return { sampleIndices, idxs: shuffled };
  }
}
