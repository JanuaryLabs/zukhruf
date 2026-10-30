import type { Embeddings } from '../types/encoder-io.ts';
import { sum, sumFloat32 } from './numpy.ts';

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
