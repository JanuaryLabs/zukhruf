import type { Embeddings } from '../types/encoder-io.ts';
import { log } from './libm.ts';
import { mean, sum, sumFloat32 } from './numpy.ts';
import { compareStrings } from './python.ts';
import { gammaln, rankdata } from './scipy.ts';

// sklearn.metrics.auc of scikit-learn 1.9: the area under a curve by the
// trapezoidal rule (np.trapezoid), for x that only rises or only falls.
export function auc(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length)
    throw new Error(
      `Found input variables with inconsistent numbers of samples: [${x.length}, ${y.length}]`,
    );
  if (x.length < 2)
    throw new Error(
      `At least 2 points are needed to compute area under curve, but x.shape = ${x.length}`,
    );
  const steps = x.slice(1).map((value, index) => value - (x[index] ?? 0));
  let direction = 1;
  if (steps.some((step) => step < 0)) {
    if (!steps.every((step) => step <= 0))
      throw new Error(
        `x is neither increasing nor decreasing : [${x.join(', ')}].`,
      );
    direction = -1;
  }
  const areas = steps.map(
    (step, index) => (step * ((y[index + 1] ?? 0) + (y[index] ?? 0))) / 2,
  );
  return direction * sum(areas);
}

// sklearn.metrics.average_precision_score of binary labels, with
// pos_label=1, no sample weights and the default average: the step
// integral of the precision-recall curve, sum((R_n - R_{n-1}) P_n)
// (metrics/_ranking.py). The curve counts the true and false positives
// at each distinct score, from the highest score down.
export function averagePrecisionScore(
  yTrue: readonly number[],
  yScore: readonly number[],
): number {
  if (yTrue.length !== yScore.length)
    throw new Error(
      `Found input variables with inconsistent numbers of samples: [${yTrue.length}, ${yScore.length}]`,
    );
  const classes = [...new Set(yTrue)].sort((a, b) => a - b);
  // type_of_target gives "multiclass" for more than two labels; the scores
  // then need a column for each class.
  if (classes.length > 2)
    throw new Error(
      `\`y_score\` needs to be of shape \`(n_samples, n_classes)\`, since \`y_true\` contains multiple classes. Got \`y_score.shape=(${yScore.length},)\`.`,
    );
  if (classes.length === 2 && !classes.includes(1))
    throw new Error(
      `pos_label=1 is not a valid label. It should be one of [${classes.join(' ')}]`,
    );
  assertAllFinite(yScore);
  const { precision, recall } = precisionRecallCurve(yTrue, yScore);
  const steps = recall
    .slice(1)
    .map(
      (value, index) =>
        (value - (recall[index] ?? 0)) * (precision[index] ?? 0),
    );
  return Math.max(0, -sum(steps));
}

// precision_recall_curve with drop_intermediate=False, in the order that it
// returns: recall falls to 0 and precision ends with 1.
function precisionRecallCurve(
  yTrue: readonly number[],
  yScore: readonly number[],
): { precision: number[]; recall: number[] } {
  const { tps, fps } = confusionMatrixAtThresholds(yTrue, yScore);
  const precision = tps.map((tp, index) => {
    const predicted = tp + (fps[index] ?? 0);
    return predicted === 0 ? 0 : tp / predicted;
  });
  const positives = tps.at(-1) ?? 0;
  // No positive label: recall is 1 at each threshold (sklearn warns).
  const recall = tps.map((tp) => (positives === 0 ? 1 : tp / positives));
  return {
    precision: [...precision.reverse(), 1],
    recall: [...recall.reverse(), 0],
  };
}

// The true and false positives at each threshold: the stable descending
// argsort of the scores, and the last index of each run of equal scores
// (_sort_inputs_and_compute_classification_thresholds).
function confusionMatrixAtThresholds(
  yTrue: readonly number[],
  yScore: readonly number[],
): { tps: number[]; fps: number[] } {
  const order = yScore
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const thresholdIdxs: number[] = [];
  for (let index = 0; index < order.length - 1; index++)
    if ((order[index + 1]?.score ?? 0) - (order[index]?.score ?? 0) !== 0)
      thresholdIdxs.push(index);
  thresholdIdxs.push(order.length - 1);
  const cumulative: number[] = [];
  let truePositives = 0;
  for (const { index } of order) {
    truePositives += yTrue[index] === 1 ? 1 : 0;
    cumulative.push(truePositives);
  }
  const tps = thresholdIdxs.map((index) => cumulative[index] ?? 0);
  return {
    tps,
    fps: thresholdIdxs.map((index, at) => 1 + index - (tps[at] ?? 0)),
  };
}

function assertAllFinite(values: Iterable<number>, dtype = 'float64'): void {
  for (const value of values) {
    if (Number.isNaN(value)) throw new Error('Input contains NaN.');
    if (!Number.isFinite(value))
      throw new Error(
        `Input contains infinity or a value too large for dtype('${dtype}').`,
      );
  }
}

// check_paired_arrays for float32 arrays: the same shape and finite values.
function checkPairedArrays(x: Embeddings, y: Embeddings): void {
  const shape = (rows: Embeddings) =>
    `(${rows.length}, ${rows[0]?.length ?? 0})`;
  if (x.length !== y.length || (x[0]?.length ?? 0) !== (y[0]?.length ?? 0))
    throw new Error(
      `X and Y should be of same shape. They were respectively ${shape(x)} and ${shape(y)} long.`,
    );
  for (const rows of [x, y])
    for (const row of rows) assertAllFinite(row, 'float32');
}

// The float32 difference of each row of x and the row of y at its index.
function difference(x: Embeddings, y: Embeddings): Float32Array[] {
  return x.map((row, index) => {
    const other = y[index] ?? new Float32Array(row.length);
    return row.map((value, column) => value - (other[column] ?? 0));
  });
}

// sklearn.utils.extmath.row_norms of a float32 array. sklearn calls
// np.einsum("ij,ij->i", X, X), whose SIMD loop adds the products in an
// order that this port does not copy: each sum here is the float32 nearest
// to the float64 sum, so a norm can differ in its last float32 bit.
export function rowNorms(x: Embeddings, squared = false): Float32Array {
  return Float32Array.from(x, (row) => {
    let squares = 0;
    for (const value of row) squares += value * value;
    const norm = Math.fround(squares);
    return squared ? norm : Math.sqrt(norm);
  });
}

// sklearn.preprocessing.normalize(X) with norm="l2" and axis=1, for float32:
// each row divided by its norm. A norm below 10 * eps of float32 counts as
// 1 (_handle_zeros_in_scale), so a zero row stays zero.
export function normalize(x: Embeddings): Float32Array[] {
  const norms = rowNorms(x);
  const tiny = Math.fround(10 * 2 ** -23);
  return x.map((row, index) => {
    const norm = norms[index] ?? 1;
    const scale = norm < tiny ? 1 : norm;
    return row.map((value) => value / scale);
  });
}

// sklearn.metrics.pairwise.paired_cosine_distances:
// 0.5 * row_norms(normalize(X) - normalize(Y), squared=True).
export function pairedCosineDistances(
  x: Embeddings,
  y: Embeddings,
): Float32Array {
  checkPairedArrays(x, y);
  return rowNorms(difference(normalize(x), normalize(y)), true).map(
    (value) => 0.5 * value,
  );
}

// sklearn.metrics.pairwise.paired_euclidean_distances: row_norms(X - Y).
export function pairedEuclideanDistances(
  x: Embeddings,
  y: Embeddings,
): Float32Array {
  checkPairedArrays(x, y);
  return rowNorms(difference(x, y));
}

// sklearn.metrics.pairwise.paired_manhattan_distances:
// np.sum(np.abs(X - Y), axis=-1), a float32 pairwise sum of each row.
export function pairedManhattanDistances(
  x: Embeddings,
  y: Embeddings,
): Float32Array {
  checkPairedArrays(x, y);
  return Float32Array.from(difference(x, y), (row) =>
    sumFloat32(row.map(Math.abs)),
  );
}

// A cluster label: an int, or a string as numpy keeps it.
export type ClusterLabel = number | string;

// np.unique(labels, return_inverse=True): the sorted distinct labels, and the
// index of each label among them. Strings sort by code point, as numpy's
// unicode strings do.
export function uniqueInverse(labels: readonly ClusterLabel[]): {
  readonly unique: ClusterLabel[];
  readonly inverse: number[];
} {
  const unique = [...new Set(labels)].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : compareStrings(String(a), String(b)),
  );
  const position = new Map(unique.map((label, index) => [label, index]));
  return { unique, inverse: labels.map((label) => position.get(label) ?? 0) };
}

// The counts of the distinct labels, in their sorted order.
function uniqueCounts(labels: readonly ClusterLabel[]): number[] {
  const { unique, inverse } = uniqueInverse(labels);
  const counts = new Array<number>(unique.length).fill(0);
  for (const index of inverse) counts[index] = (counts[index] ?? 0) + 1;
  return counts;
}

// contingency_matrix(labels_true, labels_pred, sparse=True): the count of
// each pair of a class and a cluster, as rows of the classes. The nonzero
// counts come in the order of the rows, then the columns, as sp.find gives
// them.
type Contingency = {
  readonly rows: number[];
  readonly columns: number[];
  readonly nonzero: readonly {
    readonly row: number;
    readonly column: number;
    readonly count: number;
  }[];
  readonly total: number;
};

function contingencyMatrix(
  labelsTrue: readonly ClusterLabel[],
  labelsPred: readonly ClusterLabel[],
): Contingency {
  const classes = uniqueInverse(labelsTrue);
  const clusters = uniqueInverse(labelsPred);
  const nClusters = clusters.unique.length;
  const counts = new Map<number, number>();
  classes.inverse.forEach((row, index) => {
    const cell = row * nClusters + (clusters.inverse[index] ?? 0);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  });
  const nonzero = [...counts]
    .sort(([a], [b]) => a - b)
    .map(([cell, count]) => ({
      row: Math.floor(cell / nClusters),
      column: cell % nClusters,
      count,
    }));
  const rows = new Array<number>(classes.unique.length).fill(0);
  const columns = new Array<number>(nClusters).fill(0);
  for (const { row, column, count } of nonzero) {
    rows[row] = (rows[row] ?? 0) + count;
    columns[column] = (columns[column] ?? 0) + count;
  }
  return { rows, columns, nonzero, total: labelsTrue.length };
}

function checkClusterings(
  labelsTrue: readonly unknown[],
  labelsPred: readonly unknown[],
): void {
  if (labelsTrue.length !== labelsPred.length)
    throw new Error(
      `Found input variables with inconsistent numbers of samples: [${labelsTrue.length}, ${labelsPred.length}]`,
    );
}

// _entropy(labels): the entropy of the label counts, in nats.
function entropy(labels: readonly ClusterLabel[]): number {
  if (labels.length === 0) return 1;
  const pi = uniqueCounts(labels);
  if (pi.length === 1) return 0;
  const piSum = sum(pi);
  const logSum = log(piSum);
  return -sum(pi.map((count) => (count / piSum) * (log(count) - logSum)));
}

const FLOAT64_EPS = 2 ** -52;

// mutual_info_score(None, None, contingency=contingency).
function mutualInfo(contingency: Contingency): number {
  const { rows, columns, nonzero, total } = contingency;
  if (rows.length === 1 || columns.length === 1) return 0;
  const logTotal = log(total);
  const logRows = log(sum(rows));
  const logColumns = log(sum(columns));
  const terms = nonzero.map(({ row, column, count }) => {
    const share = count / total;
    const logOuter =
      -log((rows[row] ?? 0) * (columns[column] ?? 0)) + logRows + logColumns;
    const mi = share * (log(count) - logTotal) + share * logOuter;
    return Math.abs(mi) < FLOAT64_EPS ? 0 : mi;
  });
  return Math.max(sum(terms), 0);
}

// sklearn.metrics.cluster.homogeneity_completeness_v_measure with beta 1.
export function homogeneityCompletenessVMeasure(
  labelsTrue: readonly ClusterLabel[],
  labelsPred: readonly ClusterLabel[],
): readonly [homogeneity: number, completeness: number, vMeasure: number] {
  const beta = 1;
  checkClusterings(labelsTrue, labelsPred);
  if (labelsTrue.length === 0) return [1, 1, 1];
  const entropyC = entropy(labelsTrue);
  const entropyK = entropy(labelsPred);
  const mi = mutualInfo(contingencyMatrix(labelsTrue, labelsPred));
  const homogeneity = entropyC ? mi / entropyC : 1;
  const completeness = entropyK ? mi / entropyK : 1;
  const vMeasure =
    homogeneity + completeness === 0
      ? 0
      : ((1 + beta) * homogeneity * completeness) /
        (beta * homogeneity + completeness);
  return [homogeneity, completeness, vMeasure];
}

// sklearn.metrics.v_measure_score(labels_true, labels_pred).
export function vMeasureScore(
  labelsTrue: readonly ClusterLabel[],
  labelsPred: readonly ClusterLabel[],
): number {
  return homogeneityCompletenessVMeasure(labelsTrue, labelsPred)[2];
}

// expected_mutual_information (_expected_mutual_info_fast.pyx). Python calls
// scipy's gammaln for the arrays and the C library's lgamma, exp and log in
// the loop; this port calls gammaln of scipy.ts for both, and Math.exp.
function expectedMutualInformation(
  contingency: Contingency,
  nSamples: number,
): number {
  const a = contingency.rows;
  const b = contingency.columns;
  if (a.length === 1 || b.length === 1) return 0;
  const largest = Math.max(...a, ...b);
  const nijs = Array.from({ length: largest + 1 }, (_, nij) =>
    nij === 0 ? 1 : nij,
  );
  const term1 = nijs.map((nij) => nij / nSamples);
  const logA = a.map(log);
  const logB = b.map(log);
  const logN = log(nSamples);
  const logNnij = nijs.map((nij) => logN + log(nij));
  const glnA = a.map((value) => gammaln(value + 1));
  const glnB = b.map((value) => gammaln(value + 1));
  const glnNa = a.map((value) => gammaln(nSamples - value + 1));
  const glnNb = b.map((value) => gammaln(nSamples - value + 1));
  const glnN = gammaln(nSamples + 1);
  const glnNnij = nijs.map((nij) => gammaln(nij + 1) + glnN);
  // The loop takes gammaln of the integers 1 to nSamples + 1 only.
  const glnIntegers = Array.from({ length: nSamples + 2 }, (_, m) =>
    m === 0 ? Infinity : gammaln(m),
  );
  let emi = 0;
  for (const [i, ai] of a.entries())
    for (const [j, bj] of b.entries()) {
      const end = Math.min(ai, bj) + 1;
      for (let nij = Math.max(1, ai - nSamples + bj); nij < end; nij++) {
        const term2 = (logNnij[nij] ?? 0) - (logA[i] ?? 0) - (logB[j] ?? 0);
        const gln =
          (glnA[i] ?? 0) +
          (glnB[j] ?? 0) +
          (glnNa[i] ?? 0) +
          (glnNb[j] ?? 0) -
          (glnNnij[nij] ?? 0) -
          (glnIntegers[ai - nij + 1] ?? 0) -
          (glnIntegers[bj - nij + 1] ?? 0) -
          (glnIntegers[nSamples - ai - bj + nij + 1] ?? 0);
        emi += (term1[nij] ?? 0) * term2 * Math.exp(gln);
      }
    }
  return emi;
}

// sklearn.metrics.adjusted_mutual_info_score with the arithmetic mean.
export function adjustedMutualInfoScore(
  labelsTrue: readonly ClusterLabel[],
  labelsPred: readonly ClusterLabel[],
): number {
  checkClusterings(labelsTrue, labelsPred);
  const nSamples = labelsTrue.length;
  const classes = new Set(labelsTrue).size;
  const clusters = new Set(labelsPred).size;
  if ((classes === 1 && clusters === 1) || (classes === 0 && clusters === 0))
    return 1;
  if (classes === 1 || clusters === 1) return 0;
  const contingency = contingencyMatrix(labelsTrue, labelsPred);
  const mi = mutualInfo(contingency);
  const emi = expectedMutualInformation(contingency, nSamples);
  const normalizer = (entropy(labelsTrue) + entropy(labelsPred)) / 2;
  let denominator = normalizer - emi;
  denominator =
    denominator < 0
      ? Math.min(denominator, -FLOAT64_EPS)
      : Math.max(denominator, FLOAT64_EPS);
  let numerator = mi - emi;
  numerator =
    numerator < 0
      ? Math.min(numerator, -FLOAT64_EPS)
      : Math.max(numerator, FLOAT64_EPS);
  return numerator / denominator;
}

// A class label: an int, or a string as numpy keeps it.
export type ClassLabel = number | string;

// _check_targets of 1-D labels and unique_labels: the sorted labels of both
// arrays.
function checkTargets(
  yTrue: readonly ClassLabel[],
  yPred: readonly ClassLabel[],
): ClassLabel[] {
  checkClusterings(yTrue, yPred);
  if (yTrue.length < 1)
    throw new Error(
      'Found empty input array (e.g., `y_true` or `y_pred`) while a minimum of 1 sample is required.',
    );
  const labels = [...yTrue, ...yPred];
  if (
    labels.some((label) => typeof label === 'string') &&
    labels.some((label) => typeof label === 'number')
  )
    throw new Error('Mix of label input types (string and number)');
  return uniqueInverse(labels).unique;
}

// sklearn.metrics.accuracy_score: the share of equal labels. For label
// indicator matrices, the share of rows with the same labels (subset
// accuracy).
export function accuracyScore(
  yTrue: readonly ClassLabel[],
  yPred: readonly ClassLabel[],
): number;
export function accuracyScore(
  yTrue: LabelIndicator,
  yPred: LabelIndicator,
): number;
export function accuracyScore(
  yTrue: readonly ClassLabel[] | LabelIndicator,
  yPred: readonly ClassLabel[] | LabelIndicator,
): number {
  if (isIndicator(yTrue) || isIndicator(yPred)) {
    const [indicatorTrue, indicatorPred] = checkIndicators(yTrue, yPred);
    let equal = 0;
    for (const [index, row] of indicatorTrue.entries()) {
      const predicted = indicatorPred[index] ?? [];
      if (row.every((value, column) => value === predicted[column])) equal += 1;
    }
    return equal / indicatorTrue.length;
  }
  checkTargets(yTrue, yPred);
  let equal = 0;
  for (const [index, label] of yTrue.entries())
    if (label === yPred[index]) equal += 1;
  return equal / yTrue.length;
}

// How precision_recall_fscore_support averages the scores of the labels:
// macro is their mean, weighted their mean weighted by the true count of
// each label.
export type ClassificationAverage = 'macro' | 'weighted';

// precision_recall_fscore_support with beta 1 and zero_division "warn": the
// precision, recall and F1 of each label of y_true or y_pred, averaged. A
// score whose denominator is 0 is 0 (sklearn warns).
export function precisionRecallFscore(
  yTrue: readonly ClassLabel[],
  yPred: readonly ClassLabel[],
  average: ClassificationAverage,
): { precision: number; recall: number; fScore: number } {
  const labels = checkTargets(yTrue, yPred);
  const position = new Map(labels.map((label, index) => [label, index]));
  const tpSum = new Array<number>(labels.length).fill(0);
  const predSum = new Array<number>(labels.length).fill(0);
  const trueSum = new Array<number>(labels.length).fill(0);
  for (const [index, label] of yTrue.entries()) {
    const predicted = yPred[index] ?? label;
    const truePosition = position.get(label) ?? 0;
    const predPosition = position.get(predicted) ?? 0;
    trueSum[truePosition] = (trueSum[truePosition] ?? 0) + 1;
    predSum[predPosition] = (predSum[predPosition] ?? 0) + 1;
    if (label === predicted)
      tpSum[truePosition] = (tpSum[truePosition] ?? 0) + 1;
  }
  return scoresOfCounts({ tpSum, predSum, trueSum }, average);
}

// The counts of multilabel_confusion_matrix for each label: the true
// positives, the predicted and the true count.
type LabelCounts = {
  readonly tpSum: readonly number[];
  readonly predSum: readonly number[];
  readonly trueSum: readonly number[];
};

// The precision, recall and F1 of each label from its counts, averaged.
function scoresOfCounts(
  { tpSum, predSum, trueSum }: LabelCounts,
  average: ClassificationAverage,
): { precision: number; recall: number; fScore: number } {
  const divide = (numerator: number, denominator: number) =>
    denominator === 0 ? 0 : numerator / denominator;
  const precision = tpSum.map((tp, index) => divide(tp, predSum[index] ?? 0));
  const recall = tpSum.map((tp, index) => divide(tp, trueSum[index] ?? 0));
  const fScore = tpSum.map((tp, index) =>
    divide(2 * tp, (trueSum[index] ?? 0) + (predSum[index] ?? 0)),
  );
  // _nanmean for macro; np.average with the true counts as weights for
  // weighted. The counts sum to the number of samples.
  const averaged = (scores: number[]) =>
    average === 'macro'
      ? sum(scores) / scores.length
      : sum(scores.map((score, index) => score * (trueSum[index] ?? 0))) /
        sum(trueSum);
  return {
    precision: averaged(precision),
    recall: averaged(recall),
    fScore: averaged(fScore),
  };
}

// sklearn.metrics.f1_score. For label indicator matrices, each column is a
// label.
export function f1Score(
  yTrue: readonly ClassLabel[],
  yPred: readonly ClassLabel[],
  average: ClassificationAverage,
): number;
export function f1Score(
  yTrue: LabelIndicator,
  yPred: LabelIndicator,
  average: ClassificationAverage,
): number;
export function f1Score(
  yTrue: readonly ClassLabel[] | LabelIndicator,
  yPred: readonly ClassLabel[] | LabelIndicator,
  average: ClassificationAverage,
): number {
  if (isIndicator(yTrue) || isIndicator(yPred))
    return scoresOfCounts(indicatorCounts(yTrue, yPred), average).fScore;
  return precisionRecallFscore(yTrue, yPred, average).fScore;
}

// sklearn.metrics.precision_score.
export function precisionScore(
  yTrue: readonly ClassLabel[],
  yPred: readonly ClassLabel[],
  average: ClassificationAverage,
): number {
  return precisionRecallFscore(yTrue, yPred, average).precision;
}

// sklearn.metrics.recall_score.
export function recallScore(
  yTrue: readonly ClassLabel[],
  yPred: readonly ClassLabel[],
  average: ClassificationAverage,
): number {
  return precisionRecallFscore(yTrue, yPred, average).recall;
}

// A label indicator matrix: a row of 0 and 1 for each sample, with a column
// for each label.
export type LabelIndicator = readonly (readonly number[])[];

function isIndicator(
  y: readonly ClassLabel[] | LabelIndicator,
): y is LabelIndicator {
  return Array.isArray(y[0]);
}

// _check_targets of two label indicator matrices of the same shape, with
// only 0 and 1.
function checkIndicators(
  yTrue: readonly ClassLabel[] | LabelIndicator,
  yPred: readonly ClassLabel[] | LabelIndicator,
): [LabelIndicator, LabelIndicator] {
  if (!isIndicator(yTrue) || !isIndicator(yPred))
    throw new Error(
      "Classification metrics can't handle a mix of multilabel-indicator and multiclass targets",
    );
  checkClusterings(yTrue, yPred);
  const columns = yTrue[0]?.length ?? 0;
  for (const row of [...yTrue, ...yPred]) {
    if (row.length !== columns)
      throw new Error(
        `y_true and y_pred have rows of ${columns} and ${row.length} labels.`,
      );
    if (row.some((value) => value !== 0 && value !== 1))
      throw new Error('A label indicator holds only 0 and 1.');
  }
  return [yTrue, yPred];
}

// multilabel_confusion_matrix of label indicator matrices: the counts of
// each column. A matrix of one column is a column of binary labels for
// scikit-learn, which this port does not read here.
function indicatorCounts(
  yTrue: readonly ClassLabel[] | LabelIndicator,
  yPred: readonly ClassLabel[] | LabelIndicator,
): LabelCounts {
  const [indicatorTrue, indicatorPred] = checkIndicators(yTrue, yPred);
  const columns = indicatorTrue[0]?.length ?? 0;
  if (columns < 2)
    throw new Error(
      'This port scores label indicator matrices of 2 columns or more only.',
    );
  const tpSum = new Array<number>(columns).fill(0);
  const predSum = new Array<number>(columns).fill(0);
  const trueSum = new Array<number>(columns).fill(0);
  for (const [index, row] of indicatorTrue.entries()) {
    const predicted = indicatorPred[index] ?? [];
    for (let column = 0; column < columns; column++) {
      const isTrue = row[column] === 1;
      const isPredicted = predicted[column] === 1;
      if (isTrue) trueSum[column] = (trueSum[column] ?? 0) + 1;
      if (isPredicted) predSum[column] = (predSum[column] ?? 0) + 1;
      if (isTrue && isPredicted) tpSum[column] = (tpSum[column] ?? 0) + 1;
    }
  }
  return { tpSum, predSum, trueSum };
}

// sklearn.metrics.label_ranking_average_precision_score without sample
// weights (metrics/_ranking.py): for each sample, the mean over its true
// labels of the share of true labels among the labels scored at least as
// high. A sample with no true label or only true labels scores 1.
export function labelRankingAveragePrecisionScore(
  yTrue: LabelIndicator,
  yScore: readonly (readonly number[])[],
): number {
  checkClusterings(yTrue, yScore);
  const columns = yTrue[0]?.length ?? 0;
  if (yScore.some((row) => row.length !== columns))
    throw new Error('y_true and y_score have different shape');
  if (
    yTrue.some(
      (row) =>
        row.length !== columns ||
        row.some((value) => value !== 0 && value !== 1),
    )
  )
    throw new Error('y_true holds labels other than 0 and 1.');
  let out = 0;
  for (const [i, row] of yTrue.entries()) {
    const relevant = row.flatMap((value, column) =>
      value === 1 ? [column] : [],
    );
    if (relevant.length === 0 || relevant.length === columns) {
      out += 1;
      continue;
    }
    const scores = (yScore[i] ?? []).map((score) => -score);
    const allRanks = rankdata(scores, 'max');
    const rank = relevant.map((column) => allRanks[column] ?? 0);
    const L = rankdata(
      relevant.map((column) => scores[column] ?? 0),
      'max',
    );
    out += mean(L.map((value, index) => value / (rank[index] ?? 1)));
  }
  return out / yTrue.length;
}

// sklearn.preprocessing.MultiLabelBinarizer with its defaults: fitTransform
// learns the sorted labels of the label sets and gives their indicator
// matrix; transform gives the indicator matrix of other label sets and
// leaves out the labels that it did not learn (scikit-learn warns).
export class MultiLabelBinarizer {
  #classes: ClassLabel[] | null = null;

  get classes(): readonly ClassLabel[] {
    if (this.#classes === null)
      throw new Error(
        "This MultiLabelBinarizer instance is not fitted yet. Call 'fit' with appropriate arguments before using this estimator.",
      );
    return this.#classes;
  }

  fitTransform(y: readonly (readonly ClassLabel[])[]): number[][] {
    const labels = y.flat();
    if (
      labels.some((label) => typeof label === 'string') &&
      labels.some((label) => typeof label === 'number')
    )
      throw new TypeError(
        "'<' not supported between instances of 'str' and 'int'",
      );
    this.#classes = uniqueInverse(labels).unique;
    return this.transform(y);
  }

  transform(y: readonly (readonly ClassLabel[])[]): number[][] {
    const classes = this.classes;
    const column = new Map(classes.map((label, index) => [label, index]));
    return y.map((labels) => {
      const row = new Array<number>(classes.length).fill(0);
      for (const label of labels) {
        const index = column.get(label);
        if (index !== undefined) row[index] = 1;
      }
      return row;
    });
  }
}
