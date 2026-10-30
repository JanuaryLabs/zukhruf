import gsumpw from '@stdlib/blas-ext-base-gsumpw';

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

export function f05(tp: number, fp: number, fn: number): number {
  return tp === 0 ? 0 : (1.25 * tp) / (1.25 * tp + 0.25 * fn + fp);
}

export function scores(
  accepted: readonly boolean[],
  probabilities: readonly number[],
  relevant: readonly boolean[],
): Scores {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let squares = 0;
  let positives = 0;
  for (const [index, isRelevant] of relevant.entries()) {
    const accept = accepted[index] ?? false;
    if (accept && isRelevant) tp++;
    else if (accept) fp++;
    else if (isRelevant) fn++;
    if (isRelevant) positives++;
    squares += ((probabilities[index] ?? 0) - (isRelevant ? 1 : 0)) ** 2;
  }
  const rate = positives / relevant.length;
  const climatology = rate * (1 - rate);
  const brier = squares / relevant.length;
  return {
    f05: f05(tp, fp, fn),
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    brier,
    brierSkill: climatology > 0 ? 1 - brier / climatology : Number.NaN,
    accepted: accepted.filter(Boolean).length,
    tp,
    fp,
    fn,
  };
}

// numpy.mean: the identity 0 plus numpy's pairwise sum, divided by the count.
export function mean(values: readonly number[]): number {
  return (0 + gsumpw(values.length, values, 1)) / values.length;
}

// The mean of the values that are not NaN, as numpy.nanmean.
export function nanMean(values: readonly number[]): number {
  return mean(values.filter((value) => !Number.isNaN(value)));
}
