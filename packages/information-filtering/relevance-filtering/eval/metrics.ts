import {
  BinaryAverage,
  BrierScore,
  ClassCounts,
  ProbabilityComparison,
  SquaredErrorForm,
} from '@zukhruf/evals/classification';
import { mean } from '@zukhruf/statistics';

// The scores of one design on one stream for one profile, as the research
// code computes them (round-2 evaluate.py, metric_row). T11F is the F-measure
// with beta 0.5 of TREC-11 Filtering (Robertson and Soboroff 2002): precision
// counts two times as much as recall.
export type Scores = {
  readonly f05: number;
  readonly precision: number;
  readonly recall: number;
  readonly brier: number;
  // 1 - Brier / the Brier of the base rate of the stream (climatology). NaN
  // when the stream has no relevant article or only relevant articles.
  readonly brierSkill: number;
  readonly accepted: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
};

// The research code reads the decisions and the relevance as the labels 1
// and 0 of two classes, with 1 the positive class.
const RELEVANT = 1;
const NOT_RELEVANT = 0;
const binary = new BinaryAverage(RELEVANT);
// np.mean((p - y) ** 2), as metric_row computes the Brier score.
const brierScore = new BrierScore({
  positiveLabel: RELEVANT,
  form: new SquaredErrorForm(),
});

export function scores(
  accepted: readonly boolean[],
  probabilities: readonly number[],
  relevant: readonly boolean[],
): Scores {
  const counts = ClassCounts.of({
    labels: [NOT_RELEVANT, RELEVANT],
    expected: relevant.map(Number),
    stated: accepted.map(Number),
  });
  const matrix = counts.confusionMatrix();
  const tp = matrix.count(RELEVANT, RELEVANT);
  const fp = matrix.count(NOT_RELEVANT, RELEVANT);
  const fn = matrix.count(RELEVANT, NOT_RELEVANT);
  // The Brier skill score stays here: @zukhruf/evals has no skill score.
  const rate = (tp + fn) / relevant.length;
  const climatology = rate * (1 - rate);
  const brier = brierScore.mean(
    relevant.map(
      (isRelevant, index) =>
        new ProbabilityComparison({
          probabilities: new Map([[RELEVANT, probabilities[index] ?? 0]]),
          expected: isRelevant ? RELEVANT : NOT_RELEVANT,
        }),
    ),
  );
  return {
    f05: counts.fBeta({ beta: 0.5, average: binary }),
    precision: counts.precision({ average: binary }),
    recall: counts.recall({ average: binary }),
    brier,
    brierSkill: climatology > 0 ? 1 - brier / climatology : Number.NaN,
    accepted: tp + fp,
    tp,
    fp,
    fn,
  };
}

// The mean of the values that are not NaN, as numpy.nanmean.
export function nanMean(values: readonly number[]): number {
  return mean(values.filter((value) => !Number.isNaN(value)));
}
