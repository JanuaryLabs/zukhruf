// Precision and recall with two F-measures: F1, which the literature
// reports, and F0.5, which counts precision two times as much as recall,
// because a false join hides a report from the reader and a false split only
// shows a duplicate (ADR 0003).
export type Score = {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly f05: number;
};

// A ratio whose denominator is 0 is 0, as in the reference scorer.
export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function score(precision: number, recall: number): Score {
  return {
    precision,
    recall,
    f1: fMeasure(precision, recall, 1),
    f05: fMeasure(precision, recall, 0.5),
  };
}

// van Rijsbergen (1979): F = (1 + beta^2) P R / (beta^2 P + R).
export function fMeasure(
  precision: number,
  recall: number,
  beta: number,
): number {
  const denominator = beta ** 2 * precision + recall;
  return denominator === 0
    ? 0
    : ((1 + beta ** 2) * precision * recall) / denominator;
}
