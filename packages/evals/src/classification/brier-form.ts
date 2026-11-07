// The arithmetic of the Brier score of one answer from the probability p of
// the positive label and the expected value y (1 for the positive label,
// else 0) (Strategy). Two forms give the same number in algebra and can
// differ in the last bit (ADR 0003).
export interface BrierForm {
  of(probability: number, expected: 0 | 1): number;
}

// scikit-learn 1.9.1's brier_score_loss of a one-dimensional y_proba: the
// two classes are 1 - p and p, and the score is 0.5 times the sum of the
// squares of the two columns.
export class TwoColumnForm implements BrierForm {
  of(probability: number, expected: 0 | 1): number {
    const negative = 1 - expected - (1 - probability);
    const positive = expected - probability;
    return 0.5 * (negative * negative + positive * positive);
  }
}

// (p - y)², the squared error of the probability (Brier 1950 for two
// classes), as numpy gives (p - y) ** 2.
export class SquaredErrorForm implements BrierForm {
  of(probability: number, expected: 0 | 1): number {
    return (probability - expected) ** 2;
  }
}
