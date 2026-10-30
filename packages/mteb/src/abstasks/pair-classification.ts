import {
  type Dataset,
  type DatasetValue,
  datasetFromDict,
} from '../dependencies/datasets.ts';
import { averagePrecisionScore } from '../dependencies/sklearn.ts';
import {
  type PairClassificationDistances,
  PairClassificationEvaluator,
} from '../evaluators/pair-classification-evaluator.ts';
import { isEncoder } from '../models/models-protocols.ts';
import type { TimingStack } from '../timing.ts';
import type { EncodeKwargs, PromptType } from '../types/encoder-io.ts';
import type { HFSubset, Score } from '../types/result.ts';
import { AbsTask, type MTEBModels } from './abstask.ts';

// mteb/abstasks/pair_classification.py, for text. The descriptive
// statistics and the push to the Hub are not ported.

// The accuracy, F1, precision, recall and average precision of one score.
export type PairClassificationMetrics = {
  readonly accuracy: number;
  readonly f1: number;
  readonly precision: number;
  readonly recall: number;
  readonly ap: number;
};

const MAX_METRICS = ['f1', 'ap', 'precision', 'recall', 'accuracy'];

// A pair classification task: the label of each pair of inputs is 1 when
// they are similar and 0 when not. Each score of the pairs (the cosine
// similarity, the distances, the similarity of the model and the dot
// product) ranks the pairs, and the metrics measure how well a threshold on
// that score separates the labels.
export abstract class AbsTaskPairClassification extends AbsTask<Dataset> {
  input1ColumnName = 'sentence1';
  input2ColumnName = 'sentence2';
  labelColumnName = 'labels';
  input1PromptType: PromptType | null = null;
  input2PromptType: PromptType | null = null;

  override get abstaskPrompt(): string {
    return 'Retrieve text that are semantically similar to the given text.';
  }

  protected override loadSplits(): Promise<
    Map<HFSubset, Map<string, Dataset>>
  > {
    return this.loadDatasets();
  }

  protected override async evaluateSubset(
    model: MTEBModels,
    dataSplit: Dataset,
    options: {
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly encodeKwargs: EncodeKwargs;
      readonly predictionFolder: string | null;
      readonly timer: TimingStack;
    },
  ): Promise<Record<string, Score>> {
    if (!isEncoder(model))
      throw new TypeError(
        'Expected model to be an instance of EncoderProtocol',
      );
    // The v1 format of MTEB keeps a split in one row of lists.
    const data =
      this.metadata.modalities.length === 1 &&
      this.metadata.modalities[0] === 'text' &&
      dataSplit.rows.length === 1
        ? datasetFromDict(dataSplit.rows[0] ?? {})
        : dataSplit;
    const evaluator = new PairClassificationEvaluator(data, {
      input1ColumnName: this.input1ColumnName,
      input2ColumnName: this.input2ColumnName,
      taskMetadata: this.metadata,
      hfSplit: options.hfSplit,
      hfSubset: options.hfSubset,
      input1PromptType: this.input1PromptType,
      input2PromptType: this.input2PromptType,
      timer: options.timer,
    });
    const similarityScores = await evaluator.call(model, options.encodeKwargs);
    if (options.predictionFolder !== null)
      this.saveTaskPredictions(
        {
          cosine_scores: similarityScores.cosineScores,
          euclidean_distances: similarityScores.euclideanDistances,
          manhattan_distances: similarityScores.manhattanDistances,
          similarity_scores: similarityScores.similarityScores,
          dot_scores: similarityScores.dotScores,
        },
        model,
        options.predictionFolder,
        options.hfSplit,
        options.hfSubset,
      );
    return this.computeMetrics(
      similarityScores,
      data.rows.map((row) => int64(row[this.labelColumnName])),
    );
  }

  // The metrics of each score, as <score>_<metric>, then the best value of
  // each metric over the scores, as max_<metric>.
  protected computeMetrics(
    similarityScores: PairClassificationDistances,
    labels: readonly number[],
  ): Record<string, number> {
    const outputScores: Record<string, number> = {};
    const maxScores = new Map<string, number[]>();
    const scores: [string, readonly number[], boolean][] = [
      ['similarity', similarityScores.similarityScores, true],
      ['cosine', similarityScores.cosineScores, true],
      ['manhattan', similarityScores.manhattanDistances, false],
      ['euclidean', similarityScores.euclideanDistances, false],
      ['dot', similarityScores.dotScores, true],
    ];
    for (const [shortName, values, reverse] of scores) {
      const metrics = this.computeMetricsValues(values, labels, reverse);
      for (const [metricName, metricValue] of Object.entries(metrics)) {
        outputScores[`${shortName}_${metricName}`] = metricValue;
        const values = maxScores.get(metricName) ?? [];
        values.push(metricValue);
        maxScores.set(metricName, values);
      }
    }
    for (const [metric, values] of maxScores)
      if (MAX_METRICS.includes(metric))
        outputScores[`max_${metric}`] = pythonMax(values);
    return outputScores;
  }

  // highScoreMoreSimilar: a higher score means a more similar pair.
  protected computeMetricsValues(
    scores: readonly number[],
    labels: readonly number[],
    highScoreMoreSimilar: boolean,
  ): PairClassificationMetrics {
    const [accuracy] = this.findBestAccAndThreshold(
      scores,
      labels,
      highScoreMoreSimilar,
    );
    const [f1, precision, recall] = this.findBestF1AndThreshold(
      scores,
      labels,
      highScoreMoreSimilar,
    );
    const ap = averagePrecisionScore(
      labels,
      scores.map((score) => score * (highScoreMoreSimilar ? 1 : -1)),
    );
    return { accuracy, f1, precision, recall, ap };
  }

  // The best accuracy of a threshold between two scores, and that
  // threshold. A threshold never splits equal scores.
  protected findBestAccAndThreshold(
    scores: readonly number[],
    labels: readonly number[],
    highScoreMoreSimilar: boolean,
  ): [number, number] {
    const rows = sortedRows(scores, labels, highScoreMoreSimilar);
    let maxAcc = 0;
    let bestThreshold = -1;
    let positiveSoFar = 0;
    let remainingNegatives = labels.filter((label) => label === 0).length;
    for (let i = 0; i < rows.length - 1; i++) {
      const [score, label] = rows[i] ?? [0, 0];
      const next = rows[i + 1]?.[0];
      if (label === 1) positiveSoFar += 1;
      else remainingNegatives -= 1;
      if (score === next) continue;
      const acc = (positiveSoFar + remainingNegatives) / labels.length;
      if (acc > maxAcc) {
        maxAcc = acc;
        bestThreshold = (score + (next ?? 0)) / 2;
      }
    }
    return [maxAcc, bestThreshold];
  }

  // The best F1 of a threshold between two scores, with its precision,
  // recall and threshold. A threshold never splits equal scores.
  protected findBestF1AndThreshold(
    scores: readonly number[],
    labels: readonly number[],
    highScoreMoreSimilar: boolean,
  ): [number, number, number, number] {
    const rows = sortedRows(scores, labels, highScoreMoreSimilar);
    let bestF1 = 0;
    let bestPrecision = 0;
    let bestRecall = 0;
    let threshold = 0;
    let ncorrect = 0;
    let totalNumDuplicates = 0;
    for (const label of labels) totalNumDuplicates += label;
    for (let i = 0; i < rows.length - 1; i++) {
      const [score, label] = rows[i] ?? [0, 0];
      const next = rows[i + 1]?.[0];
      if (label === 1) ncorrect += 1;
      if (score === next) continue;
      if (ncorrect > 0) {
        const precision = ncorrect / (i + 1);
        const recall = ncorrect / totalNumDuplicates;
        const f1 = (2 * precision * recall) / (precision + recall);
        if (f1 > bestF1) {
          bestF1 = f1;
          bestPrecision = precision;
          bestRecall = recall;
          threshold = (score + (next ?? 0)) / 2;
        }
      }
    }
    return [bestF1, bestPrecision, bestRecall, threshold];
  }
}

// The (score, label) pairs sorted by score, highest first when reverse.
// Python's sorted keeps equal scores in their order, also with reverse.
function sortedRows(
  scores: readonly number[],
  labels: readonly number[],
  reverse: boolean,
): [number, number][] {
  if (scores.length !== labels.length)
    throw new Error(
      `zip() argument 2 is ${labels.length > scores.length ? 'longer' : 'shorter'} than argument 1`,
    );
  return scores
    .map((score, index) => ({ score, label: labels[index] ?? 0, index }))
    .sort(
      (a, b) =>
        (reverse ? b.score - a.score : a.score - b.score) || a.index - b.index,
    )
    .map(({ score, label }) => [score, label]);
}

// Python's max: the first of the greatest values.
function pythonMax(values: readonly number[]): number {
  let best = values[0] ?? Number.NaN;
  for (const value of values.slice(1)) if (value > best) best = value;
  return best;
}

// np.asarray(labels, dtype=np.int64) for one label.
function int64(value: DatasetValue | undefined): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.trunc(value);
  throw new TypeError(`A label must be a number, not ${String(value)}.`);
}
