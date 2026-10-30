import { mean } from '../dependencies/numpy.ts';
import type { LabelIndicator } from '../dependencies/sklearn.ts';

// mteb/_evaluators/classification_metrics.py.

// hamming_score: for each sample, the labels that both matrices have divided
// by the labels that either has (1 when neither has a label), averaged over
// the samples.
export function hammingScore(
  yTrue: LabelIndicator,
  yPred: LabelIndicator,
): number {
  // The type is 2-D, so the check of numpy's ndim has nothing to catch. Rows
  // of other lengths are a shape mismatch.
  const shape = (y: LabelIndicator) =>
    `(${y.length}, ${[...new Set(y.map((row) => row.length))].join(' or ') || 0})`;
  if (shape(yTrue) !== shape(yPred) || shape(yTrue).includes(' or '))
    throw new Error(
      `Shape mismatch: y_true ${shape(yTrue)} != y_pred ${shape(yPred)}`,
    );
  if (yTrue.length === 0 || (yTrue[0]?.length ?? 0) === 0)
    throw new Error('Input arrays cannot be empty');
  const binary = (y: LabelIndicator) =>
    y.every((row) => row.every((value) => value === 0 || value === 1));
  if (!binary(yTrue) || !binary(yPred))
    throw new Error('Arrays must contain only binary values (0 and 1)');
  const scores = yTrue.map((row, i) => {
    const predicted = yPred[i] ?? [];
    let intersection = 0;
    let union = 0;
    for (const [column, value] of row.entries()) {
      const other = predicted[column];
      if (value === 1 && other === 1) intersection++;
      if (value === 1 || other === 1) union++;
    }
    return union === 0 ? 1 : intersection / union;
  });
  return mean(scores);
}
